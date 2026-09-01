import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionConfigValueId,
  type SessionId,
  type SessionInfo,
  type SessionUpdate,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";
import type { AgentConfig } from "./agents/config.ts";
import { agentEnv } from "./agents/config.ts";

/** ACP bridge package per agent kind: the npm package to resolve and which
 *  key in its `bin` map is the executable to spawn. */
const AGENT_BRIDGES: Record<AgentConfig["kind"], { packageName: string; binName: string }> = {
  claude: { packageName: "@agentclientprotocol/claude-agent-acp", binName: "claude-agent-acp" },
  codex: { packageName: "@agentclientprotocol/codex-acp", binName: "codex-acp" },
};

/** Resolves the on-disk entry point for a kind's ACP bridge bin. `require`
 *  isn't available (package.json declares "type": "module", so this file runs
 *  as ESM under Node's native TypeScript loading) — walk from this module's
 *  own URL to the extension root's node_modules instead of using Node's
 *  package resolver, avoiding any dependency on its "exports" map shape. */
export function resolveAgentEntryPoint(kind: AgentConfig["kind"]): string {
  const bridge = AGENT_BRIDGES[kind];
  const here = fileURLToPath(import.meta.url); // <extensionRoot>/src/acp/agentClient.ts
  const extensionRoot = path.resolve(path.dirname(here), "..", "..");
  const pkgJsonPath = path.join(extensionRoot, "node_modules", bridge.packageName, "package.json");
  const pkgDir = path.dirname(pkgJsonPath);
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const binRel = typeof pkgJson.bin === "string" ? pkgJson.bin : pkgJson.bin?.[bridge.binName];
  if (!binRel) {
    throw new Error(`${bridge.packageName} package does not declare a "${bridge.binName}" bin entry`);
  }
  return path.join(pkgDir, binRel);
}

export type ConnectionState = { state: "connecting" | "connected" | "error"; error?: string };
export type SessionUpdateEvent = { sessionId: SessionId; update: SessionUpdate };
export type PermissionRequestEvent = {
  requestId: string;
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
};

/** One live ACP connection to an agent's bridge subprocess. Owns the child
 *  process and the session lifecycle; consumers (tree view, session viewer,
 *  chat webview) subscribe to its events rather than the client knowing
 *  about any particular UI's message shape. */
export class AgentClient implements vscode.Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private agent?: ClientContext;
  private readonly pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>();
  private readonly output: vscode.OutputChannel;
  private permissionCounter = 0;
  private readonly cwd: string;

  private readonly connectionStateEmitter = new vscode.EventEmitter<ConnectionState>();
  private readonly sessionUpdateEmitter = new vscode.EventEmitter<SessionUpdateEvent>();
  private readonly permissionRequestEmitter = new vscode.EventEmitter<PermissionRequestEvent>();
  private readonly permissionResolvedEmitter = new vscode.EventEmitter<{ requestId: string }>();

  readonly onConnectionStateChanged = this.connectionStateEmitter.event;
  readonly onSessionUpdate = this.sessionUpdateEmitter.event;
  readonly onPermissionRequest = this.permissionRequestEmitter.event;
  readonly onPermissionResolved = this.permissionResolvedEmitter.event;

  constructor(cwd: string, label = "ACP Code") {
    this.cwd = cwd;
    this.output = vscode.window.createOutputChannel(label);
  }

  async connect(agent: AgentConfig): Promise<void> {
    this.disconnectChild();
    this.connectionStateEmitter.fire({ state: "connecting" });

    const entryPoint = resolveAgentEntryPoint(agent.kind);
    const child = spawn(process.execPath, [entryPoint], {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...agentEnv(agent),
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"] as const,
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => this.output.append(chunk.toString()));
    child.on("error", err => this.connectionStateEmitter.fire({ state: "error", error: String(err) }));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = undefined;
        this.agent = undefined;
      }
      if (code !== 0 && code !== null) {
        this.connectionStateEmitter.fire({
          state: "error",
          error: `agent bridge exited (code ${code}, signal ${signal ?? "none"})`,
        });
      }
    });

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const app = createClientApp({ name: "acpcode" })
      .onRequest(methods.client.session.requestPermission, ctx => {
        return new Promise<RequestPermissionResponse>(resolve => {
          const requestId = `perm-${++this.permissionCounter}`;
          this.pendingPermissions.set(requestId, resolve);
          ctx.signal.addEventListener("abort", () => {
            if (this.pendingPermissions.delete(requestId)) {
              resolve({ outcome: { outcome: "cancelled" } });
              this.permissionResolvedEmitter.fire({ requestId });
            }
          });
          this.permissionRequestEmitter.fire({
            requestId,
            sessionId: ctx.params.sessionId,
            toolCall: ctx.params.toolCall,
            options: ctx.params.options,
          });
        });
      })
      .onNotification(methods.client.session.update, ctx => {
        this.sessionUpdateEmitter.fire({ sessionId: ctx.params.sessionId, update: ctx.params.update });
      });

    const connection = app.connect(stream);
    this.agent = connection.agent;

    try {
      await this.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "acpcode", version: "0.0.1" },
      });
      this.connectionStateEmitter.fire({ state: "connected" });
    } catch (err) {
      this.connectionStateEmitter.fire({ state: "error", error: String(err) });
      throw err;
    }
  }

  private requireAgent(): ClientContext {
    if (!this.agent) {
      throw new Error("Not connected to an agent");
    }
    return this.agent;
  }

  /** `cwd` filters to that project directory (and its git worktrees); omit
   *  it to list sessions across every project the agent knows about. */
  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    const response = await this.requireAgent().request(methods.agent.session.list, cwd ? { cwd } : {});
    return response.sessions;
  }

  async newSession(): Promise<NewSessionResponse> {
    return this.requireAgent().request<NewSessionResponse>(methods.agent.session.new, {
      cwd: this.cwd,
      mcpServers: [],
    });
  }

  /** Loads (and replays the history of) a session on this connection. Replay
   *  arrives as ordinary `onSessionUpdate` events scoped to `sessionId`.
   *
   *  `cwd` must be the session's own recorded working directory (from its
   *  `SessionInfo.cwd`), not this connection's spawn cwd — the bridge uses it
   *  to locate the session's on-disk transcript (organized per-project), and
   *  a mismatch fails with "Resource not found" even though the session is
   *  real. Falls back to this connection's cwd for the case where a session
   *  is known to live there already (e.g. one just created on it). */
  async loadSession(sessionId: SessionId, cwd?: string): Promise<LoadSessionResponse | void> {
    return this.requireAgent().request<LoadSessionResponse | void>(methods.agent.session.load, {
      sessionId,
      cwd: cwd ?? this.cwd,
      mcpServers: [],
    });
  }

  async prompt(sessionId: SessionId, text: string): Promise<StopReason> {
    const response = await this.requireAgent().request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return response.stopReason as StopReason;
  }

  cancelPrompt(sessionId: SessionId): void {
    void this.requireAgent().notify(methods.agent.session.cancel, { sessionId });
  }

  async setConfigOption(sessionId: SessionId, configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
    const request =
      typeof value === "boolean"
        ? { sessionId, configId, value, type: "boolean" as const }
        : { sessionId, configId, value: value as SessionConfigValueId };
    const response = await this.requireAgent().request<SetSessionConfigOptionResponse>(
      methods.agent.session.setConfigOption,
      request,
    );
    return response.configOptions;
  }

  resolvePermission(requestId: string, optionId: string | null): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
  }

  private disconnectChild(): void {
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
    this.agent = undefined;
    for (const resolve of this.pendingPermissions.values()) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  dispose(): void {
    this.disconnectChild();
    this.output.dispose();
    this.connectionStateEmitter.dispose();
    this.sessionUpdateEmitter.dispose();
    this.permissionRequestEmitter.dispose();
    this.permissionResolvedEmitter.dispose();
  }
}
