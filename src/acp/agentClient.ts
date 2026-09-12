import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
  type ForkSessionResponse,
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

/** Pulls the AIR extension's session-failure title out of a response's
 *  `_meta`, but only when `severity` is "error" — see `prompt()`'s doc
 *  comment for why this needs checking at all. */
function extractAirFailureTitle(
  meta: { [key: string]: unknown } | null | undefined,
): string | undefined {
  const jetbrains = meta?.jetbrains;
  const air =
    jetbrains && typeof jetbrains === "object"
      ? (jetbrains as Record<string, unknown>).air
      : undefined;
  const failure =
    air && typeof air === "object"
      ? (air as Record<string, unknown>).sessionFailure
      : undefined;
  if (!failure || typeof failure !== "object") {
    return undefined;
  }
  const { title, severity } = failure as Record<string, unknown>;
  return severity === "error" && typeof title === "string" ? title : undefined;
}

/** ACP bridge package per agent kind: the npm package to resolve and which
 *  key in its `bin` map is the executable to spawn. */
const AGENT_BRIDGES: Record<
  AgentConfig["kind"],
  { packageName: string; binName: string }
> = {
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    binName: "claude-agent-acp",
  },
  codex: {
    packageName: "@agentclientprotocol/codex-acp",
    binName: "codex-acp",
  },
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
  const pkgJsonPath = path.join(
    extensionRoot,
    "node_modules",
    bridge.packageName,
    "package.json",
  );
  const pkgDir = path.dirname(pkgJsonPath);
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const binRel =
    typeof pkgJson.bin === "string"
      ? pkgJson.bin
      : pkgJson.bin?.[bridge.binName];
  if (!binRel) {
    throw new Error(
      `${bridge.packageName} package does not declare a "${bridge.binName}" bin entry`,
    );
  }
  return path.join(pkgDir, binRel);
}

export type ConnectionState = {
  state: "connecting" | "connected" | "error";
  error?: string;
};
export type SessionUpdateEvent = {
  sessionId: SessionId;
  update: SessionUpdate;
};
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
  private readonly pendingPermissions = new Map<
    string,
    (response: RequestPermissionResponse) => void
  >();
  private readonly output: vscode.OutputChannel;
  private permissionCounter = 0;
  private readonly cwd: string;
  // Advertised via InitializeResponse._meta.steering.supported (the agreed
  // ACP steering wire protocol, "_session/steering" — not yet a built-in
  // method in the SDK's schema, called through the generic request() escape
  // hatch). Not every agent kind implements it (e.g. codex-acp doesn't).
  private steeringSupported = false;

  private readonly connectionStateEmitter =
    new vscode.EventEmitter<ConnectionState>();
  private readonly sessionUpdateEmitter =
    new vscode.EventEmitter<SessionUpdateEvent>();
  private readonly permissionRequestEmitter =
    new vscode.EventEmitter<PermissionRequestEvent>();
  private readonly permissionResolvedEmitter = new vscode.EventEmitter<{
    requestId: string;
  }>();

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
    child.stderr.on("data", (chunk: Buffer) =>
      this.output.append(chunk.toString()),
    );
    child.on("error", err =>
      this.connectionStateEmitter.fire({ state: "error", error: String(err) }),
    );
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
        this.sessionUpdateEmitter.fire({
          sessionId: ctx.params.sessionId,
          update: ctx.params.update,
        });
      });

    const connection = app.connect(stream);
    this.agent = connection.agent;

    try {
      const response = await this.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // Unlocks the "AIR" session-failure extension (claude-agent-acp's
        // session-failure-extension.js): without declaring this, the bridge
        // silently drops connection/retry status (e.g. "Retrying Claude,
        // attempt 2 of 10") instead of sending it as a session_info_update.
        clientCapabilities: {
          _meta: {
            jetbrains: {
              air: { version: 1, capabilities: ["sessionFailure"] },
            },
          },
        },
        clientInfo: { name: "acpcode", version: "0.0.1" },
      });
      const steeringMeta = response._meta?.steering;
      this.steeringSupported =
        !!steeringMeta &&
        typeof steeringMeta === "object" &&
        (steeringMeta as { supported?: unknown }).supported === true;
      this.connectionStateEmitter.fire({ state: "connected" });
    } catch (err) {
      this.connectionStateEmitter.fire({ state: "error", error: String(err) });
      throw err;
    }
  }

  canSteer(): boolean {
    return this.steeringSupported;
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
    const response = await this.requireAgent().request(
      methods.agent.session.list,
      cwd ? { cwd } : {},
    );
    return response.sessions;
  }

  async newSession(cwd?: string): Promise<NewSessionResponse> {
    return this.requireAgent().request<NewSessionResponse>(
      methods.agent.session.new,
      {
        cwd: cwd ?? this.cwd,
        mcpServers: [],
      },
    );
  }

  /** Only available if the agent advertises the `sessionCapabilities.delete`
   *  capability (claude-agent-acp always does; codex-acp may not). */
  async deleteSession(sessionId: SessionId): Promise<void> {
    await this.requireAgent().request(methods.agent.session.delete, {
      sessionId,
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
  async loadSession(
    sessionId: SessionId,
    cwd?: string,
  ): Promise<LoadSessionResponse | void> {
    return this.requireAgent().request<LoadSessionResponse | void>(
      methods.agent.session.load,
      {
        sessionId,
        cwd: cwd ?? this.cwd,
        mcpServers: [],
      },
    );
  }

  /** Forks a session: resumes its history under a *new* session id instead of
   *  the original one. The only available fallback when `loadSession` fails
   *  because the original is currently owned by a live `claude --bg`
   *  background-agent process elsewhere — ACP has no way to attach to that
   *  process, only to branch off a copy of its history. */
  async forkSession(
    sessionId: SessionId,
    cwd?: string,
  ): Promise<ForkSessionResponse> {
    return this.requireAgent().request<ForkSessionResponse>(
      methods.agent.session.fork,
      {
        sessionId,
        cwd: cwd ?? this.cwd,
        mcpServers: [],
      },
    );
  }

  /** `failureTitle` surfaces an AIR session failure (see
   *  session-failure-extension.js's `sessionFailureMeta`) that settled the
   *  turn WITHOUT a `RequestError` — e.g. hitting a spend/usage limit ends
   *  the turn normally (`stopReason: "end_turn"`) with the real reason
   *  attached only to this response's `_meta`, not thrown. Miss it here and
   *  the caller has no way to know the turn "succeeded" into silence. Only
   *  `severity: "error"` failures are reported; `"warning"` ones (e.g.
   *  transient retry notices) arrive separately as `session_info_update`. */
  async prompt(
    sessionId: SessionId,
    text: string,
  ): Promise<{ stopReason: StopReason; failureTitle?: string }> {
    this.echoUserMessage(sessionId, text);
    const response = await this.requireAgent().request(
      methods.agent.session.prompt,
      {
        sessionId,
        prompt: [{ type: "text", text }],
      },
    );
    return {
      stopReason: response.stopReason as StopReason,
      failureTitle: extractAirFailureTitle(response._meta),
    };
  }

  /** Injects a follow-up message into a turn that's already running, instead
   *  of queuing a fresh `session/prompt` behind it. Calling `prompt()` again
   *  while one is in flight sends an un-marked message the running turn
   *  treats as an interrupt (matching the interactive CLI's "type to steer,
   *  it interrupts" behavior) — `_session/steering` is the purpose-built
   *  method that instead marks the message so the SDK folds it into the
   *  active turn. Only call this when `canSteer()` is true and the caller
   *  already knows (client-side) that a turn is genuinely in flight.
   *
   *  Echoes only after the request succeeds — unlike `prompt()`'s
   *  optimistic-before-the-call echo — because the webview shows a steer as a
   *  dimmed provisional bubble until acknowledged (see
   *  SessionViewSession.sendPrompt's steering branch and the reducer's
   *  `pendingSteerText`), which becomes the real transcript entry only once
   *  this echo fires. Echoing before the request, like `prompt()` does, would
   *  leave a permanent bubble behind even if the injection itself failed. */
  async steer(sessionId: SessionId, text: string): Promise<void> {
    await this.requireAgent().request("_session/steering", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    this.echoUserMessage(sessionId, text);
  }

  /** ACP doesn't echo a prompt you send back as a `user_message_chunk` (that
   *  update kind is only otherwise seen during history replay) — so without
   *  this, only whichever `SessionViewSession` sent the message would ever
   *  know a turn boundary happened there; every other view sharing this
   *  connection (e.g. the sidebar, when the message was sent from an editor
   *  tab) would never see it, merging two turns into one and folding away
   *  content that should stay pinned as "the last item of the completed
   *  turn." Firing it through the same `onSessionUpdate` every view already
   *  subscribes to fixes that for all of them in one place, instead of each
   *  view needing its own client-side optimistic echo. */
  private echoUserMessage(sessionId: SessionId, text: string): void {
    this.sessionUpdateEmitter.fire({
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  cancelPrompt(sessionId: SessionId): void {
    void this.requireAgent().notify(methods.agent.session.cancel, {
      sessionId,
    });
  }

  async setConfigOption(
    sessionId: SessionId,
    configId: string,
    value: string | boolean,
  ): Promise<SessionConfigOption[]> {
    const request =
      typeof value === "boolean"
        ? { sessionId, configId, value, type: "boolean" as const }
        : { sessionId, configId, value: value as SessionConfigValueId };
    const response =
      await this.requireAgent().request<SetSessionConfigOptionResponse>(
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
    resolve({
      outcome: optionId
        ? { outcome: "selected", optionId }
        : { outcome: "cancelled" },
    });
    // Every SessionViewSession sharing this connection stays subscribed to
    // this event, not just whichever view the click happened in — without
    // firing it here, a sibling view (e.g. the sidebar, when the click was in
    // an editor tab) never learns the request settled and keeps showing its
    // buttons as active.
    this.permissionResolvedEmitter.fire({ requestId });
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
