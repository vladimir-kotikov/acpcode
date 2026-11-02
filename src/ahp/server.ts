import {
  AhpErrorCodes,
  chatReducer,
  IS_CLIENT_DISPATCHABLE,
  JsonRpcErrorCodes,
  rootReducer,
  sessionReducer,
  type ActionEnvelope,
  type ActionOrigin,
  type ChatAction,
  type ChatState,
  type InitializeParams,
  type InitializeResult,
  type ReconnectParams,
  type ReconnectResult,
  type RootAction,
  type RootState,
  type SessionAction,
  type SessionState,
  type Snapshot,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import type { Disposable, Output } from "../shared/events.ts";
import { WebSocketServer, type WebSocket } from "ws";

export const ROOT_CHANNEL = "ahp-root://";
const PROTOCOL_VERSION = "1.0.0";
// How many recent action envelopes `reconnect` can replay before falling back
// to fresh snapshots.
const REPLAY_BUFFER_SIZE = 2000;

/** Thrown from a request handler to send a specific JSON-RPC error code. */
export class AhpRequestError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AhpConnection {
  readonly ws: WebSocket;
  clientId?: string;
}

export type AhpRequestHandler = (params: never) => unknown;

export interface AhpServerHooks {
  /** Requests other than the ones the server answers itself
   *  (initialize/ping/reconnect/subscribe/unsubscribe/dispatchAction). */
  readonly handlers: Record<string, AhpRequestHandler>;
  /** Called before a subscribe snapshot is taken, so the owner can create the
   *  channel's state on first use (e.g. load an agent session's history).
   *  A channel that still has no state afterwards answers NotFound. */
  readonly materialize: (channel: string) => Promise<void>;
  /** Called after a client-dispatched action has been applied. */
  readonly onClientAction: (channel: string, action: StateAction) => void;
}

type ChannelState = RootState | SessionState | ChatState;
/** Which reducer a channel's state goes through. Not derivable from the URI:
 *  sessions created by the client live under its own `<provider>:/…` URI. */
export type ChannelKind = "root" | "session" | "chat";

function reduce(
  kind: ChannelKind,
  state: ChannelState,
  action: StateAction,
  log: (msg: string) => void,
): ChannelState {
  if (kind === "root") {
    return rootReducer(state as RootState, action as RootAction, log);
  }
  if (kind === "session") {
    return sessionReducer(state as SessionState, action as SessionAction, log);
  }
  return chatReducer(state as ChatState, action as ChatAction, log);
}

/** A minimal Agent Host Protocol server: one authoritative state tree per
 *  channel, mutated only through the protocol package's own reducers (the
 *  same ones every client runs, so host and client can't disagree on what an
 *  action means), sequenced and broadcast to subscribers. Knows nothing about
 *  agents — `AhpServerHooks` supplies everything channel-specific. */
export class AhpServer implements Disposable {
  private readonly states = new Map<string, ChannelState>();
  private readonly kinds = new Map<string, ChannelKind>();
  private readonly subscribers = new Map<string, Set<AhpConnection>>();
  private readonly connections = new Set<AhpConnection>();
  private readonly replayBuffer: ActionEnvelope[] = [];
  private readonly servedClients = new Set<string>();
  private serverSeq = 0;
  private wss?: WebSocketServer;
  private readonly hooks: AhpServerHooks;
  private readonly output: Output;
  private readonly defaultDirectory: () => string | undefined;

  constructor(
    hooks: AhpServerHooks,
    output: Output,
    defaultDirectory: () => string | undefined,
  ) {
    this.hooks = hooks;
    this.output = output;
    this.defaultDirectory = defaultDirectory;
  }

  /** Resolves once listening; rejects on e.g. EADDRINUSE. */
  listen(port: number, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port,
        verifyClient: ({ req }: { req: { url?: string } }) =>
          new URL(req.url ?? "", "http://localhost").searchParams.get("tkn") ===
          token,
      });
      wss.once("listening", () => {
        this.wss = wss;
        resolve();
      });
      wss.once("error", reject);
      wss.on("connection", ws => this.accept(ws));
    });
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  has(channel: string): boolean {
    return this.states.has(channel);
  }

  /** Seeds a channel's initial state. No action is broadcast — nobody can be
   *  subscribed to a channel that didn't exist yet. */
  create(channel: string, kind: ChannelKind, state: ChannelState): void {
    this.states.set(channel, state);
    this.kinds.set(channel, kind);
  }

  delete(channel: string): void {
    this.states.delete(channel);
    this.kinds.delete(channel);
    this.subscribers.delete(channel);
  }

  /** Applies a server-originated action and broadcasts it. */
  dispatch(channel: string, action: StateAction): void {
    this.apply(channel, action, undefined);
  }

  /** Broadcasts a protocol notification (e.g. `root/sessionAdded`) to every
   *  connection, subscribed or not. */
  notify(method: string, params: object): void {
    for (const connection of this.connections) {
      this.send(connection, { jsonrpc: "2.0", method, params });
    }
  }

  private apply(
    channel: string,
    action: StateAction,
    origin: ActionOrigin | undefined,
    rejectionReason?: string,
  ): void {
    const state = this.states.get(channel);
    if (state && !rejectionReason) {
      this.states.set(
        channel,
        reduce(this.kinds.get(channel)!, state, action, msg =>
          this.output.appendLine(`[reducer] ${channel}: ${msg}`),
        ),
      );
    }
    const envelope: ActionEnvelope = {
      channel,
      action,
      serverSeq: ++this.serverSeq,
      origin,
      ...(rejectionReason ? { rejectionReason } : {}),
    };
    this.replayBuffer.push(envelope);
    if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) {
      this.replayBuffer.shift();
    }
    for (const connection of this.subscribers.get(channel) ?? []) {
      this.send(connection, {
        jsonrpc: "2.0",
        method: "action",
        params: envelope,
      });
    }
  }

  private snapshot(channel: string): Snapshot {
    return {
      resource: channel,
      state: this.states.get(channel)!,
      fromSeq: this.serverSeq,
    } as Snapshot;
  }

  private async subscribe(
    channel: string,
    connection: AhpConnection,
  ): Promise<Snapshot | undefined> {
    if (!this.states.has(channel)) {
      await this.hooks.materialize(channel);
    }
    if (!this.states.has(channel)) {
      return undefined;
    }
    let set = this.subscribers.get(channel);
    if (!set) {
      set = new Set();
      this.subscribers.set(channel, set);
    }
    set.add(connection);
    return this.snapshot(channel);
  }

  private async initialize(
    params: InitializeParams,
    connection: AhpConnection,
  ): Promise<InitializeResult> {
    connection.clientId = params.clientId;
    this.servedClients.add(params.clientId);
    if (!params.protocolVersions.some(v => v.startsWith("1."))) {
      throw Object.assign(
        new AhpRequestError(
          AhpErrorCodes.UnsupportedProtocolVersion,
          `Unsupported protocol versions: ${params.protocolVersions.join(", ")}`,
        ),
        { data: { supportedVersions: [PROTOCOL_VERSION] } },
      );
    }
    const snapshots: Snapshot[] = [];
    for (const channel of params.initialSubscriptions ?? []) {
      const snapshot = await this.subscribe(channel, connection);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverSeq: this.serverSeq,
      serverInfo: { name: "acpcode", title: "ACP Code" },
      snapshots,
      defaultDirectory: this.defaultDirectory(),
    };
  }

  private async reconnect(
    params: ReconnectParams,
    connection: AhpConnection,
  ): Promise<ReconnectResult> {
    connection.clientId = params.clientId;
    const oldest = this.replayBuffer[0]?.serverSeq ?? this.serverSeq + 1;
    // Replay only continues state this host instance itself handed out. A
    // client it has never served (e.g. one whose initialize hit a previous
    // instance, or failed before this one was listening) can carry a seq
    // that happens to fall inside our range — replaying "nothing missed" to
    // it would leave it without any root snapshot, i.e. no agents. Same for
    // a gap older than the buffer: fresh snapshots instead.
    const canReplay =
      this.servedClients.has(params.clientId) &&
      params.lastSeenServerSeq >= oldest - 1 &&
      params.lastSeenServerSeq <= this.serverSeq;
    this.servedClients.add(params.clientId);
    const snapshots: Snapshot[] = [];
    const missing: string[] = [];
    for (const channel of params.subscriptions) {
      const snapshot = await this.subscribe(channel, connection);
      if (snapshot) {
        snapshots.push(snapshot);
      } else {
        missing.push(channel);
      }
    }
    if (!canReplay) {
      return { type: "snapshot", snapshots } as ReconnectResult;
    }
    const wanted = new Set(params.subscriptions);
    return {
      type: "replay",
      actions: this.replayBuffer.filter(
        envelope =>
          envelope.serverSeq > params.lastSeenServerSeq &&
          wanted.has(envelope.channel),
      ),
      missing,
    } as ReconnectResult;
  }

  private dispatchFromClient(
    params: { channel: string; clientSeq: number; action: StateAction },
    connection: AhpConnection,
  ): void {
    const origin: ActionOrigin = {
      clientId: connection.clientId ?? "",
      clientSeq: params.clientSeq,
    };
    if (!this.states.has(params.channel)) {
      return; // spec: actions on unknown channels are silently ignored
    }
    if (!IS_CLIENT_DISPATCHABLE[params.action.type]) {
      this.apply(
        params.channel,
        params.action,
        origin,
        `${params.action.type} is not client-dispatchable`,
      );
      return;
    }
    this.apply(params.channel, params.action, origin);
    this.hooks.onClientAction(params.channel, params.action);
  }

  private async handle(
    method: string,
    params: never,
    connection: AhpConnection,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params, connection);
      case "reconnect":
        return this.reconnect(params, connection);
      case "ping":
        return null;
      case "subscribe": {
        const { channel } = params as { channel: string };
        const snapshot = await this.subscribe(channel, connection);
        if (!snapshot) {
          throw new AhpRequestError(
            AhpErrorCodes.NotFound,
            `Unknown channel ${channel}`,
          );
        }
        return { snapshot };
      }
      case "unsubscribe":
        this.subscribers
          .get((params as { channel: string }).channel)
          ?.delete(connection);
        return null;
      case "dispatchAction":
        this.dispatchFromClient(params, connection);
        return null;
    }
    const handler = this.hooks.handlers[method];
    if (!handler) {
      // VS Code also sends its own non-AHP extension requests
      // (getNetworkDiagnosticsInfo, setClientManagedSettingsPermissions…);
      // MethodNotFound is what it expects from a host that lacks them.
      throw new AhpRequestError(
        JsonRpcErrorCodes.MethodNotFound,
        `${method} is not supported`,
      );
    }
    return handler(params);
  }

  private accept(ws: WebSocket): void {
    const connection: AhpConnection = { ws };
    this.connections.add(connection);
    ws.on("close", () => {
      this.connections.delete(connection);
      for (const set of this.subscribers.values()) {
        set.delete(connection);
      }
    });
    ws.on("message", raw => void this.onMessage(String(raw), connection));
  }

  private async onMessage(
    raw: string,
    connection: AhpConnection,
  ): Promise<void> {
    let message: { id?: number; method?: string; params?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      this.send(connection, {
        jsonrpc: "2.0",
        id: null,
        error: { code: JsonRpcErrorCodes.ParseError, message: "Parse error" },
      });
      return;
    }
    if (!message.method) {
      return; // a response to a server->client request; we never send any
    }
    try {
      const result = await this.handle(
        message.method,
        (message.params ?? {}) as never,
        connection,
      );
      if (message.id !== undefined) {
        this.send(connection, {
          jsonrpc: "2.0",
          id: message.id,
          result: result ?? null,
        });
      }
    } catch (err) {
      const code =
        err instanceof AhpRequestError
          ? err.code
          : JsonRpcErrorCodes.InternalError;
      if (code !== JsonRpcErrorCodes.MethodNotFound) {
        this.output.appendLine(`[error] ${message.method}: ${String(err)}`);
      }
      if (message.id !== undefined) {
        this.send(connection, {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code,
            message: err instanceof Error ? err.message : String(err),
            ...((err as { data?: unknown }).data
              ? { data: (err as { data?: unknown }).data }
              : {}),
          },
        });
      }
    }
  }

  private send(connection: AhpConnection, message: object): void {
    if (connection.ws.readyState === connection.ws.OPEN) {
      connection.ws.send(JSON.stringify(message));
    }
  }

  dispose(): void {
    for (const connection of this.connections) {
      connection.ws.close();
    }
    this.wss?.close();
  }
}
