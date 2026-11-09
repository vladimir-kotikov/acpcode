import {
  client as createClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type AvailableCommand,
  type ClientContext,
  type ContentBlock,
  type ForkSessionResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PermissionOption,
  type PromptCapabilities,
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
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Emitter, type Disposable, type Output } from "../shared/events.ts";
import type { Attachment } from "../shared/sessionViewProtocol.ts";
import type { AgentConfig } from "./agents/config.ts";
import { agentProcessEnv, bridgeEntryPoint } from "./bridges.ts";

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

/** The slash command each agent kind's CLI recognizes as "drop prior
 *  conversation from the model's context." Not every kind has one — codex-acp
 *  exposes no equivalent built-in (its closest, `/compact`, summarizes rather
 *  than drops) — so lookups fall through to `undefined` and both `prompt()`
 *  and `withResetCommand()` below simply leave it out. Only resets the
 *  *display*; the agent's own CLI is what actually drops the content from
 *  its context. Doubles as the composer's menu entry (`name`/`description`
 *  are exactly `AvailableCommand`'s shape) since neither bridge actually
 *  advertises this one through `available_commands_update` itself. */
const RESET_COMMANDS: Partial<Record<AgentConfig["kind"], AvailableCommand>> = {
  claude: {
    name: "clear",
    description: "Clear conversation history and free up context",
  },
};

export type ConnectionState = {
  state: "connecting" | "connected" | "error";
  error?: string;
};
/** `_session/list/changes`: rows that changed, and ids that are gone. */
export interface SessionListChanges {
  subscriptionId: string;
  sessions: SessionInfo[];
  removed: string[];
}

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
export type TranscriptResetEvent = {
  sessionId: SessionId;
};

export type SteeringResponse =
  | { outcome: "injected" }
  | { outcome: "startedNewTurn" }
  | { outcome: "promptRequired"; reason: "noRunningTurn" }
  | { outcome: "failed" };

/** `RequestError`'s `message` is often just the generic JSON-RPC category
 *  (e.g. "Internal error") — the agent-specific detail, when present, is in
 *  `.data`, which `String(err)` drops entirely. An *uncaught* exception in the
 *  bridge's request handler (as opposed to one it deliberately throws as a
 *  `RequestError` with its own message) gets wrapped by the ACP SDK itself as
 *  `internalError({ details: <original message> })` — unwrap that shape
 *  directly instead of dumping raw JSON at the user. */
export function describeError(err: unknown): string {
  if (err instanceof RequestError) {
    const data = err.data;
    if (
      data &&
      typeof data === "object" &&
      "details" in data &&
      typeof data.details === "string"
    ) {
      return data.details;
    }
    const detail = data !== undefined ? ` ${JSON.stringify(data)}` : "";
    return `${err.message}${detail}`;
  }
  return String(err);
}

/** One live ACP connection to an agent's bridge subprocess. Owns the child
 *  process and the session lifecycle; consumers (tree view, session viewer,
 *  chat webview) subscribe to its events rather than the client knowing
 *  about any particular UI's message shape. */
export class AgentClient implements Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private agent?: ClientContext;
  // Set in `connect()` — read by `prompt()` to look up this kind's reset
  // command (see `RESET_COMMANDS`).
  private kind?: AgentConfig["kind"];
  private readonly pendingPermissions = new Map<
    string,
    {
      sessionId: SessionId;
      resolve: (response: RequestPermissionResponse) => void;
    }
  >();
  private readonly output: Output;
  private permissionCounter = 0;
  private readonly cwd: string;
  // Advertised via InitializeResponse._meta.steering.supported (the agreed
  // ACP steering wire protocol, "_session/steering" — not yet a built-in
  // method in the SDK's schema, called through the generic request() escape
  // hatch).
  private steeringSupported = false;
  // From InitializeResponse.agentCapabilities.promptCapabilities — `text` and
  // `resource_link` are baseline (every agent MUST accept them per the ACP
  // spec), everything else needs this check before it's safe to send.
  private promptCapabilities: PromptCapabilities = {};
  /** What the agent advertised in `initialize`; ACP's optional session
   *  methods are only called when it did. */
  private agentCapabilities: AgentCapabilities = {};
  /** `_meta.jetbrains.air.capabilities` the bridge advertised back, e.g.
   *  `sessionIndex` once we've declared it. */
  private airCapabilities = new Set<string>();

  private readonly connectionStateEmitter = new Emitter<ConnectionState>();
  private readonly sessionUpdateEmitter = new Emitter<SessionUpdateEvent>();
  private readonly permissionRequestEmitter =
    new Emitter<PermissionRequestEvent>();
  private readonly permissionResolvedEmitter = new Emitter<{
    requestId: string;
  }>();
  private readonly transcriptResetEmitter = new Emitter<TranscriptResetEvent>();

  readonly onConnectionStateChanged = this.connectionStateEmitter.event;
  readonly onSessionUpdate = this.sessionUpdateEmitter.event;
  private readonly sessionListChangesEmitter =
    new Emitter<SessionListChanges>();
  /** Pushed rows of the lists subscribed with `subscribeSessionList`. */
  readonly onSessionListChanges = this.sessionListChangesEmitter.event;
  readonly onPermissionRequest = this.permissionRequestEmitter.event;
  readonly onPermissionResolved = this.permissionResolvedEmitter.event;
  // Fired instead of (just before) the normal echo when `prompt()` recognizes
  // the agent's own history-reset command (see `RESET_COMMANDS`) — every view
  // sharing this connection's session needs it, same reasoning as
  // `echoUserMessage`'s doc comment, so it rides the same emitter pattern
  // rather than being each view's own problem to detect.
  readonly onTranscriptReset = this.transcriptResetEmitter.event;

  constructor(cwd: string, output: Output) {
    this.cwd = cwd;
    this.output = output;
  }

  /** Spawns the agent's bridge, installing it first if needed (see
   *  `bridgeEntryPoint`); `entryPoint` overrides which bridge install. */
  async connect(agent: AgentConfig, entryPoint?: string): Promise<void> {
    this.disconnectChild();
    this.kind = agent.kind;
    this.connectionStateEmitter.fire({ state: "connecting" });

    let env: NodeJS.ProcessEnv;
    try {
      env = { ...agentProcessEnv(agent), ELECTRON_RUN_AS_NODE: "1" };
      entryPoint ??= await bridgeEntryPoint(agent.kind);
    } catch (err) {
      this.connectionStateEmitter.fire({ state: "error", error: String(err) });
      throw err;
    }
    this.output.appendLine(`[acpcode] Bridge: ${entryPoint}`);
    const child = spawn(process.execPath, [entryPoint], {
      cwd: this.cwd,
      env,
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
          this.pendingPermissions.set(requestId, {
            sessionId: ctx.params.sessionId,
            resolve,
          });
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
      .onNotification(
        "_session/list/changes",
        { parse: params => params as SessionListChanges },
        ctx => this.sessionListChangesEmitter.fire(ctx.params),
      )
      .onNotification(methods.client.session.update, ctx => {
        const update = ctx.params.update;
        this.sessionUpdateEmitter.fire({
          sessionId: ctx.params.sessionId,
          update:
            update.sessionUpdate === "available_commands_update"
              ? {
                  ...update,
                  availableCommands: this.withResetCommand(
                    update.availableCommands,
                  ),
                }
              : update,
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
              air: {
                version: 1,
                // sessionIndex: session/list rows carry `_meta.jetbrains.air`
                // (forkedFrom, lastPromptAt, model, state, archived) and
                // the bridge offers rename/archive/list-change methods.
                capabilities: ["sessionFailure", "sessionIndex"],
              },
            },
          },
        },
        clientInfo: { name: "acpcode", version: "0.0.1" },
      });
      // An agent that can't speak the requested version answers with the
      // latest one it does speak.
      if (response.protocolVersion !== PROTOCOL_VERSION) {
        this.disconnectChild();
        throw new Error(
          `the agent bridge speaks ACP protocol v${response.protocolVersion}, ACP Code needs v${PROTOCOL_VERSION}`,
        );
      }
      const steeringMeta = response._meta?.steering;
      this.steeringSupported =
        !!steeringMeta &&
        typeof steeringMeta === "object" &&
        (steeringMeta as { supported?: unknown }).supported === true;
      this.agentCapabilities = response.agentCapabilities ?? {};
      this.promptCapabilities =
        response.agentCapabilities?.promptCapabilities ?? {};
      const air = (
        response._meta?.jetbrains as
          { air?: { capabilities?: string[] } } | undefined
      )?.air;
      this.airCapabilities = new Set(air?.capabilities);
      this.connectionStateEmitter.fire({ state: "connected" });
    } catch (err) {
      this.connectionStateEmitter.fire({ state: "error", error: String(err) });
      throw err;
    }
  }

  /** ACP: a client MUST NOT call an optional method the agent didn't
   *  advertise — fails here instead. */
  private requireCapability(method: string, advertised: unknown): void {
    if (!advertised) {
      throw new Error(`the agent doesn't support ${method}`);
    }
  }

  /** `additionalDirectories`, for an agent that takes them. */
  private directories(additionalDirectories: string[] | undefined): {
    additionalDirectories?: string[];
  } {
    return additionalDirectories?.length &&
      this.agentCapabilities.sessionCapabilities?.additionalDirectories
      ? { additionalDirectories }
      : {};
  }

  /** A throwaway connection to a freshly installed bridge; see `BridgeProbe`. */
  static async probe(
    agent: AgentConfig,
    entryPoint: string,
    cwd: string,
    output: Output,
  ): Promise<void> {
    const client = new AgentClient(cwd, output);
    try {
      await client.connect(agent, entryPoint);
    } finally {
      client.disconnectChild();
    }
  }

  /** Whether session/list rows carry the index metadata, and the
   *  `_session/*` methods below exist. */
  canIndexSessions(): boolean {
    return this.airCapabilities.has("sessionIndex");
  }

  async renameSession(sessionId: SessionId, title: string): Promise<void> {
    await this.requireAgent().request("_session/rename", { sessionId, title });
  }

  async archiveSession(sessionId: SessionId, archived: boolean): Promise<void> {
    await this.requireAgent().request(
      archived ? "_session/archive" : "_session/unarchive",
      { sessionId },
    );
  }

  /** Starts pushing `onSessionListChanges` for the sessions of `cwd`. */
  async subscribeSessionList(cwd: string): Promise<string> {
    const response = await this.requireAgent().request<{
      subscriptionId: string;
    }>("_session/list/subscribe", { cwd });
    return response.subscriptionId;
  }

  canSteer(): boolean {
    return this.steeringSupported;
  }

  /** Whether a pathless image attachment (pasted clipboard bytes, no source
   *  file) can be sent as an inline `image` content block. A file attachment,
   *  or an image that DOES have a source `uri`, never needs this — those fall
   *  back to `resource_link`, which every agent accepts. */
  canSendImages(): boolean {
    return !!this.promptCapabilities.image;
  }

  private requireAgent(): ClientContext {
    if (!this.agent) {
      throw new Error("Not connected to an agent");
    }
    return this.agent;
  }

  /** `cwd` filters to that project directory (and its git worktrees); omit
   *  it to list sessions across every project the agent knows about. */
  async listSessions(
    cwd?: string,
    includeArchived = false,
  ): Promise<SessionInfo[]> {
    // The bridge pages its list (at most 200 rows a page with its session
    // index, see `sessionIndex` below).
    this.requireCapability(
      "session/list",
      this.agentCapabilities.sessionCapabilities?.list,
    );
    const sessions: SessionInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      seen.add(cursor ?? "");
      const response = await this.requireAgent().request(
        methods.agent.session.list,
        {
          ...(cwd ? { cwd } : {}),
          ...(cursor ? { cursor } : {}),
          // Archived rows come too when asked (flagged in `_meta`); the index
          // lists 50 rows a page unless told otherwise.
          _meta: {
            jetbrains: {
              air: {
                list: {
                  limit: 200,
                  ...(includeArchived && { archived: "all" }),
                },
              },
            },
          },
        },
      );
      sessions.push(...response.sessions);
      cursor = response.nextCursor ?? undefined;
    } while (cursor && !seen.has(cursor)); // a repeated cursor would loop
    return sessions;
  }

  async newSession(
    cwd?: string,
    additionalDirectories?: string[],
  ): Promise<NewSessionResponse> {
    return this.requireAgent().request<NewSessionResponse>(
      methods.agent.session.new,
      {
        cwd: cwd ?? this.cwd,
        mcpServers: [],
        ...this.directories(additionalDirectories),
      },
    );
  }

  /** Re-applies a live session's directory set: the bridge rebuilds the
   *  session (keeping its history and permission mode) when it differs from
   *  the one it runs with, which is how `/add-dir` takes effect. Also
   *  makes a session live without replaying its history. Resolves to the
   *  session's config options, if the agent sent them. */
  async resumeSession(
    sessionId: SessionId,
    cwd: string,
    additionalDirectories: string[],
  ): Promise<SessionConfigOption[] | undefined> {
    this.requireCapability(
      "session/resume",
      this.agentCapabilities.sessionCapabilities?.resume,
    );
    const response = await this.requireAgent().request(
      methods.agent.session.resume,
      {
        sessionId,
        cwd,
        mcpServers: [],
        // Sent even when empty: that drops the ones the session had.
        ...(this.agentCapabilities.sessionCapabilities
          ?.additionalDirectories && { additionalDirectories }),
      },
    );
    return response.configOptions ?? undefined;
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.requireCapability(
      "session/delete",
      this.agentCapabilities.sessionCapabilities?.delete,
    );
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
    additionalDirectories?: string[],
  ): Promise<LoadSessionResponse | void> {
    this.requireCapability("session/load", this.agentCapabilities.loadSession);
    return this.requireAgent().request<LoadSessionResponse | void>(
      methods.agent.session.load,
      {
        sessionId,
        cwd: cwd ?? this.cwd,
        mcpServers: [],
        ...this.directories(additionalDirectories),
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
    options: { additionalDirectories?: string[]; atMessageId?: string } = {},
  ): Promise<ForkSessionResponse> {
    const { additionalDirectories, atMessageId } = options;
    this.requireCapability(
      "session/fork",
      this.agentCapabilities.sessionCapabilities?.fork,
    );
    return this.requireAgent().request<ForkSessionResponse>(
      methods.agent.session.fork,
      {
        sessionId,
        cwd: cwd ?? this.cwd,
        mcpServers: [],
        ...this.directories(additionalDirectories),
        // claude-agent-acp's fork point (its AIR extension): copy the history
        // up to this message instead of all of it.
        ...(atMessageId && {
          _meta: {
            jetbrains: {
              air: { fork: { version: 1, messageId: atMessageId } },
            },
          },
        }),
      },
    );
  }

  /** Builds one `ContentBlock` per attachment, in the cheapest form the
   *  connected agent accepts: an image with a source `uri` (or any
   *  non-image) becomes a baseline `resource_link` — the agent reads it off
   *  disk itself, no bytes cross the wire. Only a pathless image (pasted
   *  clipboard bytes with nowhere else to point) needs inlining as a base64
   *  `image` block, and only when `canSendImages()` — the composer already
   *  checks that before ever creating such an attachment (see
   *  `SessionViewMeta.canAttachImages`), so `undefined` here should be
   *  unreachable in practice; still handled instead of throwing, since a
   *  dropped attachment is a much smaller surprise than a failed send. */
  private attachmentToBlock(
    attachment: Attachment,
  ): Promise<ContentBlock | undefined> {
    const isImage = attachment.mimeType?.startsWith("image/") ?? false;
    if (isImage && this.canSendImages() && attachment.data) {
      return Promise.resolve({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType!,
        uri: attachment.uri,
      });
    }
    if (isImage && this.canSendImages() && attachment.uri) {
      // ponytail: file: URIs only (vscode.workspace.fs also read untitled:/
      // virtual documents); a non-file URI rejects instead of throwing.
      return Promise.resolve(attachment.uri)
        .then(uri => fs.promises.readFile(fileURLToPath(uri)))
        .then(bytes => ({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType!,
          uri: attachment.uri,
        }));
    }
    if (attachment.uri) {
      return Promise.resolve({
        type: "resource_link",
        uri: attachment.uri,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
    }
    return Promise.resolve(undefined);
  }

  private buildContentBlocks(
    text: string,
    attachments: Attachment[],
  ): Promise<ContentBlock[]> {
    return Promise.all(
      attachments.map(attachment => this.attachmentToBlock(attachment)),
    ).then(blocks => {
      const resolved = blocks.filter(
        (block): block is ContentBlock => block !== undefined,
      );
      return text ? [{ type: "text", text }, ...resolved] : resolved;
    });
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
    attachments: Attachment[] = [],
  ): Promise<{ stopReason: StopReason; failureTitle?: string }> {
    // Checked before echoing: the agent's CLI drops its own context either
    // way, but nothing in ACP tells a client that happened (no "history
    // reset" update kind exists) — so without this, the display would just
    // keep accumulating right through it. Matched on the command word alone
    // (ignoring any trailing args) the same way the bridges themselves parse
    // their own local commands.
    const resetCommand = this.kind && RESET_COMMANDS[this.kind];
    if (
      resetCommand &&
      `/${resetCommand.name}` === text.trim().split(/\s+/, 1)[0]
    ) {
      this.transcriptResetEmitter.fire({ sessionId });
    }
    const blocks = await this.buildContentBlocks(text, attachments);
    this.echoUserMessage(sessionId, blocks);
    const response = await this.requireAgent().request(
      methods.agent.session.prompt,
      { sessionId, prompt: blocks },
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
  async steer(
    sessionId: SessionId,
    text: string,
    attachments: Attachment[] = [],
  ): Promise<SteeringResponse> {
    const blocks = await this.buildContentBlocks(text, attachments);
    const response = await this.requireAgent().request<SteeringResponse>(
      "_session/steering",
      {
        sessionId,
        prompt: blocks,
        _meta: { steering: { idleBehavior: "promptRequired" } },
      },
    );
    if (
      response.outcome === "injected" ||
      response.outcome === "startedNewTurn"
    ) {
      this.echoUserMessage(sessionId, blocks);
    }
    return response;
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
   *  view needing its own client-side optimistic echo.
   *
   *  Fires one event per block (matching how the bridge itself replays a
   *  multi-block message — see integration_points.md's note on
   *  `toAcpNotifications`) rather than one event carrying the whole array,
   *  since `user_message_chunk`'s `content` field is a single `ContentBlock`,
   *  not an array — the webview's reducer merges consecutive chunks sharing
   *  the same `messageId` back into one block (state.ts's
   *  `appendUserChunk`/`sameMessage`), so every block fired here shares one
   *  freshly generated id, never reused across calls (see `appendUserChunk`'s
   *  doc comment for why reusing the previous call's id would be wrong —
   *  it's what used to glue "/clear" onto the next message typed after it). */
  private echoUserMessage(sessionId: SessionId, blocks: ContentBlock[]): void {
    const messageId = randomUUID();
    for (const content of blocks) {
      this.sessionUpdateEmitter.fire({
        sessionId,
        update: { sessionUpdate: "user_message_chunk", content, messageId },
      });
    }
  }

  /** Neither bridge actually lists its reset command (see `RESET_COMMANDS`)
   *  among the real `available_commands_update` it sends, so the composer's
   *  "/" menu would never suggest it even though `prompt()` above already
   *  acts on it — patched in here instead of in the webview so the two stay
   *  impossible to drift apart (same lookup, same source). `some` guard:
   *  skip adding it if a future bridge version ever does advertise it. */
  private withResetCommand(commands: AvailableCommand[]): AvailableCommand[] {
    const reset = this.kind && RESET_COMMANDS[this.kind];
    return reset && !commands.some(c => c.name === reset.name)
      ? [...commands, reset]
      : commands;
  }

  cancelPrompt(sessionId: SessionId): void {
    void this.requireAgent().notify(methods.agent.session.cancel, {
      sessionId,
    });
    // ACP prompt-turn: the client MUST answer the session's pending
    // permission requests with `cancelled` once it has cancelled the turn.
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        this.resolvePermission(requestId, null);
      }
    }
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
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve({
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
    for (const { resolve } of this.pendingPermissions.values()) {
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
