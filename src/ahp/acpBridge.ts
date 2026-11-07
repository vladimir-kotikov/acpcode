import type {
  AvailableCommand,
  PermissionOption,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  ActionType,
  AhpErrorCodes,
  ChatOriginKind,
  ChatSourceKind,
  ConfirmationOptionKind,
  JsonRpcErrorCodes,
  MessageAttachmentKind,
  MessageKind,
  ResponsePartKind,
  SessionLifecycle,
  SessionStatus,
  ToolCallConfirmationReason,
  ToolResultContentType,
  type AgentInfo,
  type ChatState,
  type ChatSummary,
  type CompletionsParams,
  type CompletionsResult,
  type CreateChatParams,
  type CreateSessionParams,
  type Message,
  type SessionChatSummary,
  type SessionState,
  type SessionSummary,
  type StateAction,
  type ToolResultContent,
} from "@microsoft/agent-host-protocol";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  describeError,
  type AgentClient,
  type SessionListChanges,
} from "../acp/agentClient.ts";
import type { AgentConnectionPool } from "../acp/agentPool.ts";
import type { AgentConfig } from "../acp/agents/config.ts";
import { agentProcessEnv } from "../acp/bridges.ts";
import { removeClaudeJob } from "../acp/claudeJobs.ts";
import type { Disposable, Output } from "../shared/events.ts";
import type { Attachment } from "../shared/sessionViewProtocol.ts";
import { buildDiffText } from "../webview/diffText.ts";
import {
  accepts,
  configSchema,
  configValues,
  modelOption,
  modelsOf,
  resolveConfig,
  resolveModelConfig,
  type ConfigValue,
} from "./configOptions.ts";
import {
  TRIGGER_CHARACTERS,
  commandItems,
  fileItems,
  listFiles,
  mentionToken,
  slashToken,
} from "./completions.ts";
import { AhpRequestError, AhpServer, ROOT_CHANNEL } from "./server.ts";

const DEFAULT_CHAT_TITLE = "New chat";
const TITLE_FROM_PROMPT_LENGTH = 60;

/** Where a tool call is in the AHP lifecycle — tracked separately from the
 *  reducer's state because ACP updates don't say which AHP transition they
 *  correspond to, and some transitions are only legal from certain states
 *  (e.g. re-sending `toolCallReady` with `confirmed` would silently approve
 *  a call that's still waiting on the user). */
interface ToolCallTracking {
  title: string;
  phase: "running" | "pending" | "done";
  permission?: { requestId: string; options: PermissionOption[] };
  // ACP's completing update usually omits content, and an absent `content`
  // in `toolCallComplete` would wipe what was shown while it ran.
  content?: ToolResultContent[];
}

/** One ACP session exposed as one AHP session with exactly one chat. */
interface Binding {
  readonly agent: AgentConfig;
  readonly sessionUri: string;
  readonly chatUri: string;
  readonly cwd: string;
  /** The session's other directories (the `/add-dir` set); `cwd` is the
   *  primary. Only agents that can take them (see `takesExtraDirectories`)
   *  ever have any. */
  additionalDirectories: string[];
  /** The session's first chat. Forked chats (`createChat`) share its URI,
   *  directories and config but each runs its own ACP session. */
  readonly primary: boolean;
  /** Set on a forked chat: where it branched off. */
  readonly origin?: { chat: string; turnId: string };
  /** Per turn, the ACP id of its last agent message: the point a fork of
   *  that turn is cut at. */
  readonly turnMessages: Map<string, string>;
  /** The session's status as its last listing reported it (archived, ...). */
  listedStatus?: SessionStatus;
  /** The directory set changed during a turn; applied when it ends. */
  directoriesDirty?: boolean;
  title: string;
  sessionId?: string;
  /** Settles once the ACP session is live on its connection (created, or its
   *  history loaded) — turns wait on it. */
  ready?: Promise<void>;
  /** True while `session/load` is replaying history: user chunks then mark
   *  turn boundaries instead of being `prompt()`'s own echo. */
  replaying: boolean;
  pendingUserText?: string;
  /** A turn was sent from this host, so the agent stores the session. */
  prompted?: boolean;
  turnId?: string;
  turnStartedAt: number;
  markdownPartId?: string;
  reasoningPartId?: string;
  readonly toolCalls: Map<string, ToolCallTracking>;
  /** The ACP session's config options, once it's created or loaded. */
  configOptions?: SessionConfigOption[];
  /** The ACP session's slash commands, once the agent has announced them. */
  commands?: AvailableCommand[];
}

/** claude-agent-acp advertises `sessionCapabilities.additionalDirectories`;
 *  codex-acp doesn't. */
const takesExtraDirectories = (agent: AgentConfig): boolean =>
  agent.kind === "claude";

/** The bridge's session index (`sessionIndex`) reports each row's activity
 *  and archive state in `_meta.jetbrains.air`. Without it, rows are idle. */
export function rowStatus(info: SessionInfo): SessionStatus {
  const air = (
    info._meta?.jetbrains as
      { air?: { state?: string; archived?: boolean } } | undefined
  )?.air;
  const state =
    air?.state === "running"
      ? SessionStatus.InProgress
      : air?.state === "error"
        ? SessionStatus.Error
        : air?.state === "requires_action"
          ? SessionStatus.InputNeeded
          : SessionStatus.Idle;
  return air?.archived ? state | SessionStatus.IsArchived : state;
}

/** The ACP session a listed one was forked from, if the session index knows:
 *  it only reads that from the head of the transcript. */
const forkedFrom = (info: SessionInfo): string | undefined =>
  (info._meta?.jetbrains as { air?: { forkedFrom?: string } } | undefined)?.air
    ?.forkedFrom;

const directoryUris = (binding: Binding): string[] =>
  [binding.cwd, ...binding.additionalDirectories].map(
    dir => pathToFileURL(dir).href,
  );

/** AHP provider IDs double as URI schemes VS Code builds draft-session
 *  resources from (`<provider>:/untitled-<uuid>`), so they must be
 *  scheme-safe — agent display names aren't. */
const providerId = (agent: AgentConfig): string =>
  `acp-${agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

function toolContent(
  content: ToolCallContent[] | null | undefined,
): ToolResultContent[] | undefined {
  if (!content?.length) {
    return undefined;
  }
  return content.flatMap((item): ToolResultContent[] => {
    if (item.type === "content" && item.content.type === "text") {
      return [{ type: ToolResultContentType.Text, text: item.content.text }];
    }
    if (item.type === "diff") {
      // ponytail: plain-text diff; AHP's FileEdit content needs the client to
      // `resourceRead` both sides through us — add when diffs need the
      // native diff editor.
      return [
        {
          type: ToolResultContentType.Text,
          text: `${item.path}\n${buildDiffText(item.oldText ?? "", item.newText)}`,
        },
      ];
    }
    return [];
  });
}

/** VS Code-side attachments → the shape `AgentClient.prompt()` already
 *  knows how to turn into ACP content blocks. */
function toAttachments(message: Message): Attachment[] {
  return (message.attachments ?? []).flatMap((attachment): Attachment[] => {
    if (attachment.type === MessageAttachmentKind.Resource) {
      return [
        {
          id: randomUUID(),
          name: attachment.label,
          uri: attachment.uri,
          mimeType: attachment.contentType,
        },
      ];
    }
    if (attachment.type === MessageAttachmentKind.EmbeddedResource) {
      return [
        {
          id: randomUUID(),
          name: attachment.label,
          data: attachment.data,
          mimeType: attachment.contentType,
        },
      ];
    }
    return [];
  });
}

/** What the host needs from wherever it runs: the extension reads these from
 *  VS Code settings and workspace folders. */
export interface AgentHostEnvironment {
  agents(): AgentConfig[];
  /** Folders whose sessions to list; the first one is the default cwd. */
  folders(): string[];
  /** Whether to list only the sessions of `folders()`, not every project's. */
  filterByWorkspace(): boolean;
  /** Last-seen ACP config options per agent name, persisted so model lists
   *  and config pickers are there before any of its sessions is opened. */
  configCache: {
    load(): Record<string, SessionConfigOption[]>;
    save(cache: Record<string, SessionConfigOption[]>): void;
  };
  /** Per agent name, whether it accepts image prompts — VS Code only lets
   *  users attach images to models that say so. */
  imageCache: {
    load(): Record<string, boolean>;
    save(cache: Record<string, boolean>): void;
  };
  /** Per `${agent}\0${sessionId}`, a session's directories beyond its cwd:
   *  the agents' session lists don't report them, so a reload would lose
   *  them. */
  directoryCache: {
    load(): Record<string, string[]>;
    save(cache: Record<string, string[]>): void;
  };
}

/** Exposes the configured ACP agents through an `AhpServer`, so VS Code's
 *  native Chat can drive them. Shares `AgentConnectionPool` with the webview
 *  frontend: one bridge subprocess per agent either way. Call
 *  `agentsChanged()` when `env.agents()` would return something new, and
 *  `bridgesChanged()` after a bridge install. */
export class AcpAgentHost implements Disposable {
  readonly server: AhpServer;
  private readonly pool: AgentConnectionPool;
  private readonly output: Output;
  private readonly bindings = new Map<string, Binding>(); // by session and chat URI
  private readonly byAcpSession = new Map<string, Binding>(); // by `${agent}\0${sessionId}`
  private readonly hookedClients = new WeakSet<AgentClient>();
  /** `claude agents` job removals in flight, by `${agent}\0${sessionId}`. */
  private readonly removingJobs = new Map<string, Promise<void>>();
  /** `${agent}\0${cwd}` of the session lists the agent is pushing changes
   *  for (`_session/list/subscribe`, one per directory). */
  private readonly watchedLists = new Set<string>();
  /** Agents whose bridge has no session index (nothing to subscribe to). */
  private readonly unindexed = new Set<string>();
  private readonly env: AgentHostEnvironment;
  private readonly knownOptions: Record<string, SessionConfigOption[]>;
  private readonly imageSupport: Record<string, boolean>;
  private readonly directories: Record<string, string[]>;
  // Agents whose last listing failed; see `bridgesChanged()`.
  private readonly unlisted = new Set<string>();

  constructor(
    pool: AgentConnectionPool,
    output: Output,
    env: AgentHostEnvironment,
  ) {
    this.pool = pool;
    this.output = output;
    this.env = env;
    this.knownOptions = env.configCache.load();
    this.imageSupport = env.imageCache.load();
    this.directories = env.directoryCache.load();
    this.server = new AhpServer(
      {
        handlers: {
          listSessions: () => this.listSessions(),
          createSession: (params: CreateSessionParams) =>
            this.createSession(params),
          disposeSession: ({ channel }: { channel: string }) =>
            this.deleteSession(channel),
          createChat: (params: CreateChatParams) => this.createChat(params),
          disposeChat: ({ channel }: { channel: string }) =>
            this.deleteChat(channel),
          resolveSessionConfig: ({
            provider,
            config,
          }: {
            provider?: string;
            config?: Record<string, unknown>;
          }) => {
            const agent = this.env
              .agents()
              .find(a => providerId(a) === provider);
            if (!agent) {
              return { schema: { type: "object", properties: {} }, values: {} };
            }
            const options = this.knownOptions[agent.name] ?? [];
            return {
              schema: configSchema(options, agent.kind),
              values: { ...configValues(options, agent.kind), ...config },
            };
          },
          sessionConfigCompletions: () => ({ items: [] }),
          completions: (params: CompletionsParams) => this.completions(params),
        },
        completionTriggerCharacters: TRIGGER_CHARACTERS,
        materialize: channel => this.materialize(channel),
        onClientAction: (channel, action) =>
          this.onClientAction(channel, action),
        rejectClientAction: (channel, action) =>
          this.rejectClientAction(channel, action),
      },
      output,
      () => this.defaultCwd() && pathToFileURL(this.defaultCwd()).href,
    );
    this.server.create(ROOT_CHANNEL, "root", { agents: this.agentInfos() });
  }

  /** A turn is running (possibly waiting on a permission prompt). */
  get busy(): boolean {
    return [...this.bindings.values()].some(binding => binding.turnId);
  }

  agentsChanged(): void {
    this.server.dispatch(ROOT_CHANNEL, {
      type: ActionType.RootAgentsChanged,
      agents: this.agentInfos(),
    });
  }

  private agentInfos(): AgentInfo[] {
    return this.env.agents().map(agent => {
      const provider = providerId(agent);
      // Until one of its sessions has been opened, the agent's models aren't
      // known; "Default" leaves the choice to the agent.
      const models = modelsOf(
        this.knownOptions[agent.name] ?? [],
        provider,
      ) ?? [{ id: "default", provider, name: "Default" }];
      // ponytail: ACP advertises image support per agent, not per model, so
      // every model of an image-capable agent claims vision.
      const supportsVision = this.imageSupport[agent.name];
      return {
        provider,
        displayName: agent.name,
        description: `${agent.kind} via ACP`,
        models: models.map(model => ({ ...model, supportsVision })),
        // The primary is the session's cwd, which fixes where its transcript
        // lives, so only the rest of the set can change.
        ...(takesExtraDirectories(agent) && {
          capabilities: {
            multipleWorkingDirectories: { immutablePrimary: true },
            multipleChats: { fork: true },
          },
        }),
      };
    });
  }

  /** Records a session's current options; they also become the agent's
   *  defaults for model lists and new sessions. */
  private rememberOptions(
    binding: Binding,
    options: SessionConfigOption[],
  ): void {
    binding.configOptions = options;
    const name = binding.agent.name;
    const provider = providerId(binding.agent);
    const modelsBefore = JSON.stringify(
      modelsOf(this.knownOptions[name] ?? [], provider),
    );
    this.knownOptions[name] = options;
    this.env.configCache.save(this.knownOptions);
    if (JSON.stringify(modelsOf(options, provider)) !== modelsBefore) {
      this.agentsChanged();
    }
  }

  /** Sets one ACP config option if it isn't already `value`; the agent
   *  answers with the full, possibly changed, option list. */
  private async setOption(
    binding: Binding,
    option: SessionConfigOption,
    value: ConfigValue,
  ): Promise<void> {
    if (option.currentValue === value) {
      return;
    }
    const client = await this.connect(binding);
    const options = await client.setConfigOption(
      binding.sessionId!,
      option.id,
      value,
    );
    this.rememberOptions(binding, options);
  }

  /** Switches the ACP session to the model (and effort etc.) the message
   *  was sent with. */
  private async applyModelSelection(
    binding: Binding,
    message: Message,
  ): Promise<void> {
    const options = () => binding.configOptions ?? [];
    const model = modelOption(options());
    if (model && accepts(model, message.model?.id)) {
      await this.setOption(binding, model, message.model.id);
    }
    // Looked up again after each change: the agent may change the list.
    for (const [key, value] of Object.entries(message.model?.config ?? {})) {
      const target = resolveModelConfig(options(), key, value);
      if (target) {
        await this.setOption(binding, target.option, target.value);
      }
    }
  }

  /** Runs `call` on the session's connection if the bridge has a session
   *  index; without one, the change stays in Chat only. */
  private async withIndex(
    binding: Binding,
    call: (client: AgentClient) => Promise<void>,
  ): Promise<void> {
    try {
      await binding.ready;
      const client = await this.connect(binding);
      if (client.canIndexSessions() && binding.sessionId) {
        await call(client);
      }
    } catch (err) {
      this.output.appendLine(`[sessionIndex] ${describeError(err)}`);
    }
  }

  /** A client changed the session's directory set (already applied to its
   *  state): hand the new set to every ACP session of the session's chats. */
  private syncDirectories(sessionUri: string): void {
    const state = this.server.stateOf(sessionUri) as SessionState;
    const [, ...rest] = (state.workingDirectories ?? [])
      .filter(uri => uri.startsWith("file:"))
      .map(uri => fileURLToPath(uri));
    // Chat's own list of the set follows what it just changed.
    this.server.notify("root/sessionSummaryChanged", {
      channel: ROOT_CHANNEL,
      session: sessionUri,
      changes: { workingDirectories: state.workingDirectories },
    });
    for (const chat of this.chatsOf(sessionUri)) {
      // Adding a directory the session has, or removing one it lacks, is
      // nothing to tell the agent (and resuming rebuilds its session).
      if (
        chat.additionalDirectories.length === rest.length &&
        chat.additionalDirectories.every((dir, i) => dir === rest[i])
      ) {
        continue;
      }
      if (chat.turnId) {
        // Resuming rebuilds the agent's session, which ends a running turn.
        chat.directoriesDirty = true;
      } else {
        void this.applyDirectories(chat);
      }
    }
  }

  private async applyDirectories(binding: Binding): Promise<void> {
    const state = this.server.stateOf(binding.sessionUri) as SessionState;
    const [, ...rest] = (state.workingDirectories ?? [])
      .filter(uri => uri.startsWith("file:"))
      .map(uri => fileURLToPath(uri));
    binding.additionalDirectories = rest;
    this.rememberDirectories(binding);
    try {
      await binding.ready;
      const client = await this.connect(binding);
      await client.resumeSession(binding.sessionId!, binding.cwd, rest);
    } catch (err) {
      this.output.appendLine(`[directories] ${describeError(err)}`);
    }
  }

  private rememberDirectories(binding: Binding): void {
    if (!binding.sessionId || !takesExtraDirectories(binding.agent)) {
      return;
    }
    const key = `${binding.agent.name}\0${binding.sessionId}`;
    const before = JSON.stringify(this.directories[key] ?? []);
    if (before === JSON.stringify(binding.additionalDirectories)) {
      return;
    }
    if (binding.additionalDirectories.length) {
      this.directories[key] = binding.additionalDirectories;
    } else {
      delete this.directories[key];
    }
    this.saveDirectories();
  }

  private saveDirectories(): void {
    try {
      this.env.directoryCache.save(this.directories);
    } catch (err) {
      this.output.appendLine(`[directories] ${describeError(err)}`);
    }
  }

  /** The primary directory is the agent's cwd, which fixes where its session
   *  lives: Chat may add to the set but not remove or replace the first. */
  private rejectClientAction(
    channel: string,
    action: StateAction,
  ): string | undefined {
    const binding = this.bindings.get(channel);
    if (
      binding &&
      action.type === ActionType.ChatIsArchivedChanged &&
      this.pool.get(binding.agent.name)?.canIndexSessions() === false
    ) {
      // Nowhere to keep it: the chat would come back on the next listing.
      return `${binding.agent.name} can't archive chats`;
    }
    if (
      binding?.sessionUri !== channel ||
      (action.type !== ActionType.SessionWorkingDirectoryRemoved &&
        action.type !== ActionType.SessionWorkingDirectoryReplaced)
    ) {
      return undefined;
    }
    return action.directory.startsWith("file:") &&
      path.resolve(fileURLToPath(action.directory)) ===
        path.resolve(binding.cwd)
      ? "the primary working directory can't be changed"
      : undefined;
  }

  /** Applies AHP config values (`acp.<id>` keys) to the ACP session, then
   *  publishes what the agent actually ended up with. */
  private async applyConfig(
    binding: Binding,
    config: Record<string, unknown>,
  ): Promise<void> {
    try {
      await (binding.ready ?? this.ensureLoaded(binding));
      for (const [key, value] of Object.entries(config)) {
        const target = resolveConfig(
          binding.configOptions ?? [],
          binding.agent.kind,
          key,
          value,
        );
        if (target) {
          await this.setOption(binding, target.option, target.value);
        }
      }
    } catch (err) {
      this.output.appendLine(`[config] ${describeError(err)}`);
    }
    if (binding.configOptions) {
      this.server.dispatch(binding.sessionUri, {
        type: ActionType.SessionConfigChanged,
        config: configValues(binding.configOptions, binding.agent.kind),
      });
    }
  }

  private defaultCwd(): string {
    return this.env.folders()[0] ?? os.homedir();
  }

  private async connect(binding: Binding): Promise<AgentClient> {
    const client = await this.pool.connect(binding.agent, binding.cwd);
    if (!this.hookedClients.has(client)) {
      this.hookedClients.add(client);
      const agentName = binding.agent.name;
      if (this.imageSupport[agentName] !== client.canSendImages()) {
        this.imageSupport[agentName] = client.canSendImages();
        this.env.imageCache.save(this.imageSupport);
        this.agentsChanged();
      }
      client.onSessionUpdate(({ sessionId, update }) => {
        const target = this.byAcpSession.get(`${agentName}\0${sessionId}`);
        if (target) {
          this.onSessionUpdate(target, update);
        }
      });
      client.onSessionListChanges(changes =>
        this.onListChanges(binding.agent, changes),
      );
      // A restarted bridge has no subscriptions; the next listing makes them.
      client.onConnectionStateChanged(({ state }) => {
        if (state !== "connected") {
          for (const key of this.watchedLists) {
            if (key.startsWith(`${agentName}\0`)) {
              this.watchedLists.delete(key);
            }
          }
        }
      });
      client.onPermissionRequest(request => {
        const target = this.byAcpSession.get(
          `${agentName}\0${request.sessionId}`,
        );
        if (target) {
          this.onPermissionRequest(target, request);
        }
      });
    }
    return client;
  }

  private bind(binding: Binding, sessionId: string): void {
    binding.sessionId = sessionId;
    this.byAcpSession.set(`${binding.agent.name}\0${sessionId}`, binding);
  }

  private register(
    agent: AgentConfig,
    sessionUri: string,
    chatUri: string,
    cwd: string,
    additionalDirectories: string[] = [],
    primary = true,
  ): Binding {
    const binding: Binding = {
      agent,
      sessionUri,
      chatUri,
      cwd,
      additionalDirectories,
      primary,
      turnMessages: new Map(),
      replaying: false,
      turnStartedAt: 0,
      title: DEFAULT_CHAT_TITLE,
      toolCalls: new Map(),
    };
    if (primary) {
      this.bindings.set(sessionUri, binding);
    }
    this.bindings.set(chatUri, binding);
    return binding;
  }

  // --- session catalogue -----------------------------------------------------

  private listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.listAgents(this.env.agents()).then(items => ({ items }));
  }

  /** A bridge was installed or updated: lists the agents whose last listing
   *  failed (e.g. their bridge wasn't installed yet) and announces their
   *  sessions one by one, as AHP has no "list changed" notification and VS
   *  Code only lists on connect. Agents that were listed keep the bridge
   *  they're connected to until the host restarts. */
  async bridgesChanged(): Promise<void> {
    this.unindexed.clear(); // an updated bridge may have a session index now
    const agents = this.env.agents().filter(a => this.unlisted.has(a.name));
    for (const summary of await this.listAgents(agents)) {
      this.server.notify("root/sessionAdded", {
        channel: ROOT_CHANNEL,
        summary,
      });
    }
  }

  private async listAgents(agents: AgentConfig[]): Promise<SessionSummary[]> {
    const folders = this.env.filterByWorkspace() ? this.env.folders() : [];
    const perAgent = await Promise.all(
      agents.map(async agent => {
        try {
          const client = await this.pool.connect(agent, this.defaultCwd());
          const lists = await Promise.all(
            folders.length
              ? folders.map(folder => client.listSessions(folder, true))
              : [client.listSessions(undefined, true)],
          );
          this.unlisted.delete(agent.name);
          const listed = new Map(lists.flat().map(i => [i.sessionId, i]));
          // Forks first, so their sessions' summaries list them as chats.
          const sessions = [...listed.values()].filter(info => {
            // A fork already shown as a session of its own (listed before its
            // parent was) stays one until the host restarts, rather than
            // being pulled from under Chat.
            const sessionUri = this.byAcpSession.get(
              `${agent.name}\0${info.sessionId}`,
            )?.primary
              ? undefined
              : this.forkRoot(agent, info, listed);
            if (sessionUri) {
              this.bindForkRow(agent, info, sessionUri);
            }
            return !sessionUri;
          });
          return sessions.flatMap(info => this.summaryFor(agent, info) ?? []);
        } catch (err) {
          this.unlisted.add(agent.name);
          this.output.appendLine(
            `[listSessions] ${agent.name}: ${describeError(err)}`,
          );
          return [];
        }
      }),
    );
    // Multi-root workspaces (e.g. git worktrees) can list one session twice.
    const items = new Map(perAgent.flat().map(s => [s.resource, s]));
    return [...items.values()];
  }

  /** The session a listed fork is a chat of: that of its earliest ancestor
   *  this host runs or `listed` has. None when it isn't a fork, or its parent
   *  is gone, so it's a session of its own. */
  private forkRoot(
    agent: AgentConfig,
    info: SessionInfo,
    listed: Map<string, SessionInfo>,
  ): string | undefined {
    let root: string | undefined;
    const seen = new Set([info.sessionId]);
    for (let id = forkedFrom(info); id && !seen.has(id);) {
      seen.add(id);
      const live = this.byAcpSession.get(`${agent.name}\0${id}`);
      if (live) {
        return live.sessionUri;
      }
      const row = listed.get(id);
      if (!row) {
        break;
      }
      root = `ahp-session:/${providerId(agent)}/${encodeURIComponent(id)}`;
      id = forkedFrom(row);
    }
    return root;
  }

  /** A listed fork as a chat of `sessionUri` — e.g. one made before the host
   *  restarted. Its fork point isn't known any more, so it has no origin. */
  private bindForkRow(
    agent: AgentConfig,
    info: SessionInfo,
    sessionUri: string,
  ): Binding {
    const status = rowStatus(info);
    const live = this.byAcpSession.get(`${agent.name}\0${info.sessionId}`);
    if (live) {
      live.listedStatus = status;
      return live;
    }
    const binding = this.register(
      agent,
      sessionUri,
      `ahp-chat:/${providerId(agent)}/${encodeURIComponent(info.sessionId)}`,
      info.cwd,
      info.additionalDirectories ??
        this.directories[`${agent.name}\0${info.sessionId}`] ??
        [],
      false,
    );
    this.bind(binding, info.sessionId);
    binding.title = info.title || binding.title;
    binding.listedStatus = status;
    return binding;
  }

  /** A forked chat's ACP session is listed too, but it's a chat of its
   *  parent's session, not a session of its own. */
  private summaryFor(
    agent: AgentConfig,
    info: SessionInfo,
  ): SessionSummary | undefined {
    const { binding, summary } = this.bindRow(agent, info);
    if (!binding.primary) {
      return undefined;
    }
    this.watchList(agent, binding.cwd);
    return summary;
  }

  /** Listed sessions get URIs derived from their ACP identity, so the same
   *  session keeps the same URI across listings and VS Code reloads. */
  private bindRow(
    agent: AgentConfig,
    info: SessionInfo,
  ): { binding: Binding; summary: SessionSummary } {
    const key = `${providerId(agent)}/${encodeURIComponent(info.sessionId)}`;
    const sessionUri = `ahp-session:/${key}`;
    const chatUri = `ahp-chat:/${key}`;
    // A session this host already runs (e.g. one Chat created, under its own
    // URI) keeps its binding; its row only refreshes the status.
    const binding =
      this.byAcpSession.get(`${agent.name}\0${info.sessionId}`) ??
      this.bindings.get(sessionUri) ??
      this.register(
        agent,
        sessionUri,
        chatUri,
        info.cwd,
        info.additionalDirectories ??
          this.directories[`${agent.name}\0${info.sessionId}`] ??
          [],
      );
    if (!binding.sessionId) {
      this.bind(binding, info.sessionId);
    }
    const status = rowStatus(info);
    binding.listedStatus = status;
    if (binding.primary) {
      binding.title = info.title || binding.title;
    }
    const summary = this.summary(
      binding,
      info.updatedAt ?? new Date().toISOString(),
      status,
    );
    return { binding, summary };
  }

  /** Asks an index-capable bridge to push changes of the sessions in `cwd`,
   *  which keeps Chat's list fresh without it having to re-list. */
  private watchList(agent: AgentConfig, cwd: string): void {
    const key = `${agent.name}\0${cwd}`;
    // The bridge allows 128 subscriptions per connection.
    if (
      this.unindexed.has(agent.name) ||
      this.watchedLists.has(key) ||
      this.watchedLists.size >= 100
    ) {
      return;
    }
    this.watchedLists.add(key);
    void this.pool
      .connect(agent, this.defaultCwd())
      .then(client => {
        if (!client.canIndexSessions()) {
          this.unindexed.add(agent.name);
          this.watchedLists.delete(key);
          return;
        }
        return client.subscribeSessionList(cwd);
      })
      .catch(err => {
        this.watchedLists.delete(key);
        this.output.appendLine(`[listSubscribe] ${describeError(err)}`);
      });
  }

  /** The session is open in Chat: its own channel follows a rename or an
   *  archive made elsewhere, as the root list does. */
  private mirrorRow(binding: Binding, summary: SessionSummary): void {
    const state = this.server.stateOf(binding.sessionUri) as
      SessionState | undefined;
    if (!state) {
      return;
    }
    if (summary.title !== state.title && !binding.turnId) {
      this.setTitle(binding, summary.title);
    }
    const archived = (summary.status & SessionStatus.IsArchived) !== 0;
    if (archived !== ((state.status & SessionStatus.IsArchived) !== 0)) {
      this.server.dispatch(binding.sessionUri, {
        type: ActionType.SessionIsArchivedChanged,
        isArchived: archived,
      });
    }
  }

  /** A forked chat follows its ACP session's row: its activity, and an
   *  archive made elsewhere. */
  private mirrorChatRow(binding: Binding, status: SessionStatus): void {
    const was = binding.listedStatus ?? SessionStatus.Idle;
    if (status === was) {
      binding.listedStatus = status;
      return;
    }
    const archived = (status & SessionStatus.IsArchived) !== 0;
    if (archived !== ((was & SessionStatus.IsArchived) !== 0)) {
      this.server.dispatch(binding.chatUri, {
        type: ActionType.ChatIsArchivedChanged,
        isArchived: archived,
      });
    }
    this.setChatStatus(binding, status);
  }

  /** Publishes a chat's status in its session's chat catalog. */
  private setChatStatus(binding: Binding, status: SessionStatus): void {
    binding.listedStatus = status;
    this.server.dispatch(binding.sessionUri, {
      type: ActionType.SessionChatUpdated,
      chat: binding.chatUri,
      changes: { status },
    });
    this.announceChats(binding);
  }

  private onListChanges(agent: AgentConfig, changes: SessionListChanges): void {
    for (const info of changes.sessions) {
      const live = this.byAcpSession.get(`${agent.name}\0${info.sessionId}`);
      if (live && !live.primary) {
        // A forked chat isn't a row of the session list.
        this.mirrorChatRow(live, rowStatus(info));
        continue;
      }
      const forkOf = live ? undefined : this.forkRoot(agent, info, new Map());
      if (forkOf) {
        this.addChat(this.bindForkRow(agent, info, forkOf));
        continue;
      }
      const known =
        live ??
        this.bindings.get(
          `ahp-session:/${providerId(agent)}/${encodeURIComponent(info.sessionId)}`,
        );
      const { binding, summary } = this.bindRow(agent, info);
      if (known) {
        // The row can't say what chats the session has: `chats` would
        // replace the whole catalog.
        const {
          resource: _,
          provider: __,
          createdAt: ___,
          chats: ____,
          defaultChat: _____,
          workingDirectories: ______, // Chat's own state is the authority
          ...changed
        } = summary;
        this.mirrorRow(binding, summary);
        this.server.notify("root/sessionSummaryChanged", {
          channel: ROOT_CHANNEL,
          session: binding.sessionUri,
          changes: changed,
        });
      } else {
        this.server.notify("root/sessionAdded", {
          channel: ROOT_CHANNEL,
          summary,
        });
      }
    }
    for (const sessionId of changes.removed) {
      const gone =
        this.byAcpSession.get(`${agent.name}\0${sessionId}`) ??
        this.bindings.get(
          `ahp-session:/${providerId(agent)}/${encodeURIComponent(sessionId)}`,
        );
      // Never from under a turn that's running.
      if (gone && !gone.turnId) {
        if (gone.primary) {
          this.disposeSession(gone.sessionUri);
        } else {
          this.disposeChat(gone.chatUri);
        }
      }
      const key = `${agent.name}\0${sessionId}`;
      if (key in this.directories) {
        delete this.directories[key];
        this.saveDirectories();
      }
    }
  }

  private summary(
    binding: Binding,
    modifiedAt: string,
    status = SessionStatus.Idle,
  ): SessionSummary {
    return {
      resource: binding.sessionUri,
      provider: providerId(binding.agent),
      title: binding.title,
      status,
      createdAt: modifiedAt,
      modifiedAt,
      workingDirectories: directoryUris(binding),
      defaultChat: binding.chatUri,
      chats: this.chatCatalog(binding.sessionUri, binding),
    };
  }

  private chatSummary(chat: Binding): ChatSummary {
    const status = chat.listedStatus ?? SessionStatus.Idle;
    return {
      resource: chat.chatUri,
      title: chat.title,
      // Only a fork's row keeps this current (`mirrorChatRow`); a primary
      // chat's activity would go stale, so it only carries the archive flag.
      status: chat.primary
        ? SessionStatus.Idle | (status & SessionStatus.IsArchived)
        : status,
      modifiedAt: new Date().toISOString(),
      ...(chat.origin && {
        origin: { kind: ChatOriginKind.Fork, ...chat.origin },
      }),
    };
  }

  private sessionState(binding: Binding): SessionState {
    const { title } = binding;
    const options =
      binding.configOptions ?? this.knownOptions[binding.agent.name] ?? [];
    const chats = this.chatsOf(binding.sessionUri);
    return {
      provider: providerId(binding.agent),
      title,
      status: binding.listedStatus ?? SessionStatus.Idle,
      lifecycle: SessionLifecycle.Ready,
      activeClients: [],
      chats: (chats.length ? chats : [binding]).map(c => this.chatSummary(c)),
      defaultChat: binding.chatUri,
      workingDirectories: directoryUris(binding),
      // AHP can't change a session's config schema later, only its values,
      // so a session created before its options are known uses the agent's
      // last-seen ones.
      config: {
        schema: configSchema(options, binding.agent.kind),
        values: configValues(options, binding.agent.kind),
      },
    };
  }

  /** A session's chats, its first one first. */
  private chatsOf(sessionUri: string): Binding[] {
    const chats = new Map<string, Binding>();
    for (const binding of this.bindings.values()) {
      if (binding.sessionUri === sessionUri) {
        chats.set(binding.chatUri, binding);
      }
    }
    return [...chats.values()].sort(
      (a, b) => Number(b.primary) - Number(a.primary),
    );
  }

  private chatCatalog(
    sessionUri: string,
    fallback: Binding,
  ): SessionChatSummary[] {
    const chats = this.chatsOf(sessionUri);
    return (chats.length ? chats : [fallback]).map(chat => ({
      resource: chat.chatUri,
      title: chat.title,
      // Chat's list reads a chat's archived flag from here.
      ...(chat.listedStatus !== undefined && { status: chat.listedStatus }),
      ...(chat.origin && {
        origin: { kind: ChatOriginKind.Fork, ...chat.origin },
      }),
    }));
  }

  /** The root list carries each session's chat catalog. */
  private announceChats(binding: Binding): void {
    this.server.notify("root/sessionSummaryChanged", {
      channel: ROOT_CHANNEL,
      session: binding.sessionUri,
      changes: { chats: this.chatCatalog(binding.sessionUri, binding) },
    });
  }

  private chatState(binding: Binding): ChatState {
    return {
      resource: binding.chatUri,
      title: binding.title,
      status: SessionStatus.Idle,
      modifiedAt: new Date().toISOString(),
      turns: [],
      ...(binding.origin && {
        origin: { kind: ChatOriginKind.Fork, ...binding.origin },
      }),
    };
  }

  /** Branches a chat off at a completed turn: forks the ACP session at that
   *  turn's last agent message, then loads the fork so its history replays
   *  into the new chat like any listed session's. */
  private async createChat(params: CreateChatParams): Promise<null> {
    const { source } = params;
    const parent = source && this.bindings.get(source.chat);
    if (source?.kind !== ChatSourceKind.Fork || !parent?.sessionId) {
      throw new AhpRequestError(
        JsonRpcErrorCodes.InvalidParams,
        "Only forks of an open chat are supported",
      );
    }
    if (this.bindings.has(params.chat)) {
      throw new AhpRequestError(
        JsonRpcErrorCodes.InvalidParams,
        `Chat ${params.chat} already exists`,
      );
    }
    const messageId = parent.turnMessages.get(source.turnId);
    if (!messageId) {
      throw new AhpRequestError(
        JsonRpcErrorCodes.InvalidParams,
        `Turn ${source.turnId} has no agent message to fork at`,
      );
    }
    await parent.ready;
    const client = await this.connect(parent);
    const forked = await client.forkSession(parent.sessionId, parent.cwd, {
      additionalDirectories: parent.additionalDirectories,
      atMessageId: messageId,
    });
    const binding: Binding = {
      ...parent,
      additionalDirectories: [...parent.additionalDirectories],
      chatUri: params.chat,
      primary: false,
      origin: { chat: source.chat, turnId: source.turnId },
      turnMessages: new Map(),
      toolCalls: new Map(),
      directoriesDirty: false,
      listedStatus: undefined,
      sessionId: undefined,
      ready: undefined,
      turnId: undefined,
      markdownPartId: undefined,
      reasoningPartId: undefined,
      pendingUserText: undefined,
      replaying: false,
    };
    this.bind(binding, forked.sessionId);
    this.rememberDirectories(binding);
    this.bindings.set(params.chat, binding);
    this.server.create(params.chat, "chat", this.chatState(binding));
    const loaded = this.ensureLoaded(binding);
    // A fork made with an edited message: the message is the new chat's
    // first turn, so it starts once the copied history has replayed.
    const { initialMessage } = params;
    void loaded.then(
      () => {
        if (initialMessage) {
          const turnId = randomUUID();
          this.server.dispatch(binding.chatUri, {
            type: ActionType.ChatTurnStarted,
            turnId,
            startedAt: new Date().toISOString(),
            message: initialMessage,
          });
          void this.runTurn(binding, turnId, initialMessage);
        }
      },
      err => {
        this.output.appendLine(`[createChat] ${describeError(err)}`);
        if (initialMessage) {
          // Show the failure in the chat the message was meant for.
          const turnId = randomUUID();
          this.beginTurn(binding, turnId);
          this.server.dispatch(binding.chatUri, {
            type: ActionType.ChatTurnStarted,
            turnId,
            startedAt: new Date().toISOString(),
            message: initialMessage,
          });
          this.failTurn(binding, turnId, describeError(err));
        }
      },
    );
    this.addChat(binding);
    return null;
  }

  /** Announces a session's new chat to Chat. */
  private addChat(binding: Binding): void {
    this.server.dispatch(binding.sessionUri, {
      type: ActionType.SessionChatAdded,
      summary: this.chatSummary(binding),
    });
    this.announceChats(binding);
  }

  /** Stops tracking a chat on this host; its ACP session is left alone,
   *  apart from stopping a turn that's still running. */
  private releaseChat(chat: Binding): void {
    if (chat.turnId && chat.sessionId) {
      this.pool.get(chat.agent.name)?.cancelPrompt(chat.sessionId);
    }
    this.bindings.delete(chat.chatUri);
    if (chat.sessionId) {
      this.byAcpSession.delete(`${chat.agent.name}\0${chat.sessionId}`);
    }
    this.server.delete(chat.chatUri);
  }

  /** Forgets a forked chat on this host; its ACP session stays listed. */
  private disposeChat(chatUri: string): null {
    const binding = this.bindings.get(chatUri);
    if (binding && !binding.primary) {
      this.releaseChat(binding);
      this.server.dispatch(binding.sessionUri, {
        type: ActionType.SessionChatRemoved,
        chat: chatUri,
      });
      this.announceChats(binding);
    }
    return null;
  }

  /** First subscribe to a listed session/chat: load the ACP session so its
   *  history replays into the chat's turns, and its config options are known,
   *  before either snapshot is taken. Unknown URIs (incl. VS Code's
   *  `<provider>:/untitled-…` drafts) are left alone and answer NotFound. */
  private async materialize(channel: string): Promise<void> {
    const binding = this.bindings.get(channel);
    if (!binding) {
      return;
    }
    if (!this.server.has(binding.chatUri)) {
      this.server.create(binding.chatUri, "chat", this.chatState(binding));
    }
    const loaded = this.ensureLoaded(binding);
    // The session opens even if its history can't be loaded; subscribing to
    // the chat reports why.
    await loaded.catch(() => undefined);
    if (!this.server.has(binding.sessionUri)) {
      // A fork's session is its primary chat's.
      this.server.create(
        binding.sessionUri,
        "session",
        this.sessionState(this.bindings.get(binding.sessionUri) ?? binding),
      );
    }
    if (channel === binding.chatUri) {
      await loaded;
    }
  }

  private ensureLoaded(binding: Binding): Promise<void> {
    binding.ready ??= (async () => {
      const client = await this.connect(binding);
      binding.replaying = true;
      try {
        // ponytail: loading a session the webview frontend also has open on
        // this connection replays its history into that view a second time
        // (see SessionViewSession.attachSession's `seed`).
        const response = await client.loadSession(
          binding.sessionId!,
          binding.cwd,
          binding.additionalDirectories,
        );
        if (response?.configOptions) {
          this.rememberOptions(binding, response.configOptions);
        }
        this.flushReplayedUserMessage(binding);
        this.endTurn(binding, ActionType.ChatTurnComplete);
      } finally {
        binding.replaying = false;
      }
    })().catch(err => {
      binding.ready = undefined; // let the next subscribe retry
      throw new AhpRequestError(
        JsonRpcErrorCodes.InternalError,
        `Couldn't load session: ${describeError(err)}`,
      );
    });
    return binding.ready;
  }

  private createSession(params: CreateSessionParams): Promise<null> {
    const agent = this.env
      .agents()
      .find(a => providerId(a) === params.provider);
    if (!agent) {
      throw new AhpRequestError(
        AhpErrorCodes.ProviderNotFound,
        `Unknown provider ${params.provider}`,
      );
    }
    const [cwd = this.defaultCwd(), ...additional] = (
      params.workingDirectories ?? []
    )
      .filter(uri => uri.startsWith("file:"))
      .map(uri => fileURLToPath(uri));
    const binding = this.register(
      agent,
      params.channel,
      `ahp-chat:/${randomUUID()}`,
      cwd,
      takesExtraDirectories(agent) ? additional : [],
    );
    this.server.create(binding.chatUri, "chat", this.chatState(binding));
    const ready = this.connect(binding)
      .then(client => client.newSession(cwd, binding.additionalDirectories))
      .then(response => {
        this.bind(binding, response.sessionId);
        this.rememberDirectories(binding);
        if (response.configOptions) {
          this.rememberOptions(binding, response.configOptions);
        }
      });
    binding.ready = ready;
    // The session's config schema can't change once it's published, so the
    // first session of an agent waits until its options are known.
    const known = agent.name in this.knownOptions;
    return (known ? Promise.resolve() : ready.catch(() => undefined)).then(
      () => {
        const initial = this.sessionState(binding);
        this.server.create(binding.sessionUri, "session", {
          ...initial,
          lifecycle: SessionLifecycle.Creating,
          config: initial.config && {
            ...initial.config,
            values: { ...initial.config.values, ...params.config },
          },
        });
        ready.then(
          () => {
            this.server.dispatch(binding.sessionUri, {
              type: ActionType.SessionReady,
            });
            void this.applyConfig(binding, params.config ?? {});
          },
          err =>
            this.server.dispatch(binding.sessionUri, {
              type: ActionType.SessionCreationFailed,
              error: { errorType: "agentError", message: describeError(err) },
            }),
        );
        this.server.notify("root/sessionAdded", {
          channel: ROOT_CHANNEL,
          summary: this.summary(binding, new Date().toISOString()),
        });
        return null;
      },
    );
  }

  /** Chat deleted the session: its chats' ACP sessions go too, for good. */
  private deleteSession(sessionUri: string): null {
    const chats = this.chatsOf(sessionUri);
    this.disposeSession(sessionUri);
    for (const chat of chats) {
      void this.deleteFromAgent(chat);
    }
    return null;
  }

  /** Chat deleted a forked chat: its ACP session goes too, for good. */
  private deleteChat(chatUri: string): null {
    const chat = this.bindings.get(chatUri);
    this.disposeChat(chatUri);
    if (chat && !chat.primary) {
      void this.deleteFromAgent(chat);
    }
    return null;
  }

  /** Deletes a chat's ACP session — its transcript — and its `claude agents`
   *  job. Only one the agent has stored (listed, forked or prompted): Chat
   *  also disposes the drafts it never sent. */
  private async deleteFromAgent(chat: Binding): Promise<void> {
    if (chat.listedStatus === undefined && !chat.origin && !chat.prompted) {
      return;
    }
    // Not while it's still being created or loaded: the session id may only
    // be known then. The agent ends a loaded session itself.
    await chat.ready?.catch(() => undefined);
    if (!chat.sessionId) {
      return;
    }
    try {
      const client = await this.connect(chat);
      await client.deleteSession(chat.sessionId);
    } catch (err) {
      this.output.appendLine(`[delete] ${describeError(err)}`);
    }
    await this.removeJob(chat);
  }

  /** Removes the session's `claude agents` job, as ctrl+x there does; its
   *  transcript stays. */
  private removeJob(binding: Binding): Promise<void> {
    const { agent, sessionId } = binding;
    if (agent.kind !== "claude" || !sessionId) {
      return Promise.resolve();
    }
    // Archiving the primary chat can arrive as both the session's and the
    // chat's action: one removal serves both.
    const key = `${agent.name}\0${sessionId}`;
    const inFlight = this.removingJobs.get(key);
    if (inFlight) {
      return inFlight;
    }
    const removal = Promise.resolve()
      .then(() => removeClaudeJob(agentProcessEnv(agent), sessionId))
      .then(
        printed => {
          if (printed) {
            this.output.appendLine(`[claude rm] ${printed}`);
          }
        },
        err => this.output.appendLine(`[claude rm] ${describeError(err)}`),
      )
      .finally(() => this.removingJobs.delete(key));
    this.removingJobs.set(key, removal);
    return removal;
  }

  /** Forgets the session on this host only — the agent keeps its transcript,
   *  so it shows up again on the next listing. */
  private disposeSession(sessionUri: string): null {
    for (const chat of this.chatsOf(sessionUri)) {
      this.releaseChat(chat);
    }
    this.bindings.delete(sessionUri);
    this.server.delete(sessionUri);
    this.server.notify("root/sessionRemoved", {
      channel: ROOT_CHANNEL,
      session: sessionUri,
    });
    return null;
  }

  private setTitle(binding: Binding, title: string): void {
    binding.title = title;
    if (binding.primary) {
      this.server.dispatch(binding.sessionUri, {
        type: ActionType.SessionTitleChanged,
        title,
      });
    }
    // VS Code's session list shows the *chat* title, not the session's.
    this.server.dispatch(binding.sessionUri, {
      type: ActionType.SessionChatUpdated,
      chat: binding.chatUri,
      changes: { title },
    });
    if (binding.primary) {
      this.server.notify("root/sessionSummaryChanged", {
        channel: ROOT_CHANNEL,
        session: binding.sessionUri,
        changes: { title },
      });
    }
  }

  // --- input completions -----------------------------------------------------

  private completions(
    params: CompletionsParams,
  ): CompletionsResult | Promise<CompletionsResult> {
    // VS Code only asks once a chat's session exists, so there's always one.
    const binding = this.bindings.get(params.channel);
    if (!binding) {
      return { items: [] };
    }
    const slash = slashToken(params.text, params.offset);
    if (slash) {
      // Empty until the agent announces its commands, just after the session
      // starts; they're per session (a project can add its own).
      return { items: commandItems(binding.commands ?? [], slash) };
    }
    const mention = mentionToken(params.text, params.offset);
    if (!mention) {
      return { items: [] };
    }
    return listFiles(binding.cwd).then(files => ({
      items: fileItems(binding.cwd, files, mention),
    }));
  }

  // --- client actions --------------------------------------------------------

  private onClientAction(channel: string, action: StateAction): void {
    const binding = this.bindings.get(channel);
    if (!binding) {
      return;
    }
    if (channel === binding.sessionUri) {
      if (action.type === ActionType.SessionConfigChanged) {
        void this.applyConfig(binding, action.config);
      } else if (action.type === ActionType.SessionTitleChanged) {
        binding.title = action.title;
        this.server.dispatch(binding.sessionUri, {
          type: ActionType.SessionChatUpdated,
          chat: binding.chatUri,
          changes: { title: action.title },
        });
        void this.withIndex(binding, client =>
          client.renameSession(binding.sessionId!, action.title),
        );
      } else if (action.type === ActionType.SessionIsArchivedChanged) {
        void this.withIndex(binding, client =>
          client.archiveSession(binding.sessionId!, action.isArchived),
        );
        if (action.isArchived) {
          void this.removeJob(binding);
        }
      } else if (
        action.type === ActionType.SessionWorkingDirectorySet ||
        action.type === ActionType.SessionWorkingDirectoryRemoved ||
        action.type === ActionType.SessionWorkingDirectoryReplaced
      ) {
        this.syncDirectories(binding.sessionUri);
      }
      return;
    }
    switch (action.type) {
      case ActionType.ChatTurnStarted:
        void this.runTurn(binding, action.turnId, action.message);
        return;
      case ActionType.ChatIsArchivedChanged: {
        // A chat is its own ACP session: a fork's, or for the primary chat
        // the session's, whose row then archives the session as well.
        const status = binding.listedStatus ?? SessionStatus.Idle;
        this.setChatStatus(
          binding,
          action.isArchived
            ? status | SessionStatus.IsArchived
            : status & ~SessionStatus.IsArchived,
        );
        void this.withIndex(binding, client =>
          client.archiveSession(binding.sessionId!, action.isArchived),
        );
        if (action.isArchived) {
          void this.removeJob(binding);
        }
        return;
      }
      case ActionType.ChatTurnCancelled:
        if (binding.sessionId) {
          this.pool.get(binding.agent.name)?.cancelPrompt(binding.sessionId);
        }
        this.clearTurn(binding);
        return;
      case ActionType.ChatToolCallConfirmed: {
        const tracking = binding.toolCalls.get(action.toolCallId);
        const permission = tracking?.permission;
        if (!tracking || !permission) {
          return;
        }
        const wantedKind = action.approved ? "allow" : "reject";
        const optionId =
          action.selectedOptionId ??
          permission.options.find(o => o.kind.startsWith(wantedKind))
            ?.optionId ??
          null;
        this.pool
          .get(binding.agent.name)
          ?.resolvePermission(permission.requestId, optionId);
        tracking.permission = undefined;
        tracking.phase = action.approved ? "running" : "done";
        return;
      }
    }
  }

  private async runTurn(
    binding: Binding,
    turnId: string,
    message: Message,
  ): Promise<void> {
    this.beginTurn(binding, turnId);
    binding.prompted = true;
    if (binding.title === DEFAULT_CHAT_TITLE && message.text.trim()) {
      this.setTitle(
        binding,
        message.text.trim().slice(0, TITLE_FROM_PROMPT_LENGTH),
      );
    }
    try {
      await (binding.ready ?? this.ensureLoaded(binding));
      await this.applyModelSelection(binding, message);
      const client = await this.connect(binding);
      const { stopReason, failureTitle } = await client.prompt(
        binding.sessionId!,
        message.text,
        toAttachments(message),
      );
      if (failureTitle) {
        this.failTurn(binding, turnId, failureTitle);
      } else {
        this.endTurn(
          binding,
          stopReason === "cancelled"
            ? ActionType.ChatTurnCancelled
            : ActionType.ChatTurnComplete,
          turnId,
        );
      }
    } catch (err) {
      this.failTurn(binding, turnId, describeError(err));
    }
  }

  private endTurn(
    binding: Binding,
    type: ActionType.ChatTurnComplete | ActionType.ChatTurnCancelled,
    turnId = binding.turnId,
  ): void {
    // Already ended, e.g. the client cancelled it and has its own echo.
    if (!turnId || binding.turnId !== turnId) {
      return;
    }
    this.server.dispatch(binding.chatUri, {
      type,
      turnId,
      duration: Date.now() - binding.turnStartedAt,
    });
    this.clearTurn(binding);
  }

  /** A turn is over, however it ended: a directory change that arrived
   *  during it can be applied now. */
  private clearTurn(binding: Binding): void {
    binding.turnId = undefined;
    if (binding.directoriesDirty) {
      binding.directoriesDirty = false;
      void this.applyDirectories(binding);
    }
  }

  private failTurn(binding: Binding, turnId: string, message: string): void {
    this.server.dispatch(binding.chatUri, {
      type: ActionType.ChatError,
      turnId,
      duration: Date.now() - binding.turnStartedAt,
      part: {
        kind: ResponsePartKind.Error,
        error: { errorType: "agentError", message },
      },
    });
    if (binding.turnId === turnId) {
      this.clearTurn(binding);
    }
  }

  // --- ACP → AHP mapping -----------------------------------------------------

  private beginTurn(binding: Binding, turnId: string): void {
    binding.turnId = turnId;
    binding.turnStartedAt = Date.now();
    binding.markdownPartId = undefined;
    binding.reasoningPartId = undefined;
  }

  private startTurn(binding: Binding, text: string): void {
    const turnId = randomUUID();
    this.beginTurn(binding, turnId);
    this.server.dispatch(binding.chatUri, {
      type: ActionType.ChatTurnStarted,
      turnId,
      startedAt: new Date().toISOString(),
      message: { text, origin: { kind: MessageKind.User } },
    });
  }

  /** During history replay a turn's user message can arrive as several
   *  chunks, so the turn is only started once something else follows it. */
  private flushReplayedUserMessage(binding: Binding): void {
    if (binding.pendingUserText === undefined) {
      return;
    }
    this.endTurn(binding, ActionType.ChatTurnComplete);
    this.startTurn(binding, binding.pendingUserText);
    binding.pendingUserText = undefined;
  }

  private onSessionUpdate(binding: Binding, update: SessionUpdate): void {
    if (update.sessionUpdate === "user_message_chunk") {
      // Outside replay this is `AgentClient.prompt()` echoing our own prompt
      // — the turn already exists.
      if (binding.replaying && update.content.type === "text") {
        binding.pendingUserText =
          (binding.pendingUserText ?? "") + update.content.text;
      }
      return;
    }
    if (update.sessionUpdate === "available_commands_update") {
      binding.commands = update.availableCommands;
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.rememberOptions(binding, update.configOptions);
      if (binding.primary) {
        this.server.dispatch(binding.sessionUri, {
          type: ActionType.SessionConfigChanged,
          config: configValues(update.configOptions, binding.agent.kind),
        });
      }
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      if (update.title) {
        this.setTitle(binding, update.title);
      }
      return;
    }
    if (binding.replaying) {
      this.flushReplayedUserMessage(binding);
      if (!binding.turnId) {
        this.startTurn(binding, ""); // agent output before any user message
      }
    }
    const turnId = binding.turnId;
    if (!turnId) {
      // ponytail: activity on this session driven from the webview frontend
      // isn't mirrored into AHP.
      return;
    }
    const chat = binding.chatUri;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.messageId
        ) {
          binding.turnMessages.set(turnId, update.messageId);
        }
        if (update.content.type === "text") {
          this.appendText(
            binding,
            turnId,
            update.sessionUpdate === "agent_message_chunk",
            update.content.text,
          );
        }
        return;
      case "tool_call":
        this.startToolCall(binding, turnId, update);
        this.updateToolCall(binding, turnId, update);
        return;
      case "tool_call_update":
        if (!binding.toolCalls.has(update.toolCallId)) {
          this.startToolCall(binding, turnId, update);
        }
        this.updateToolCall(binding, turnId, update);
        return;
      // ponytail: plan, usage and mode updates aren't mapped yet.
    }
  }

  /** Streams agent text into the turn: consecutive chunks of the same kind
   *  extend one part; switching kinds starts a new one. */
  private appendText(
    binding: Binding,
    turnId: string,
    isMessage: boolean,
    text: string,
  ): void {
    const current = isMessage
      ? binding.markdownPartId
      : binding.reasoningPartId;
    const partId = current ?? randomUUID();
    binding.markdownPartId = isMessage ? partId : undefined;
    binding.reasoningPartId = isMessage ? undefined : partId;
    if (current) {
      this.server.dispatch(binding.chatUri, {
        type: isMessage ? ActionType.ChatDelta : ActionType.ChatReasoning,
        turnId,
        partId,
        content: text,
      });
    } else {
      const kind = isMessage
        ? ResponsePartKind.Markdown
        : ResponsePartKind.Reasoning;
      this.server.dispatch(binding.chatUri, {
        type: ActionType.ChatResponsePart,
        turnId,
        part: { kind, id: partId, content: text },
      });
    }
  }

  /** ACP can't tell up front whether a call will need permission, so every
   *  call starts out running; a later permission request moves it back to
   *  pending-confirmation (a legal `toolCallReady` transition). */
  private startToolCall(
    binding: Binding,
    turnId: string,
    call: ToolCallUpdate,
  ): void {
    const title = call.title ?? "Tool call";
    binding.markdownPartId = undefined;
    binding.reasoningPartId = undefined;
    binding.toolCalls.set(call.toolCallId, {
      title,
      phase: "running",
    });
    this.server.dispatch(binding.chatUri, {
      type: ActionType.ChatToolCallStart,
      turnId,
      toolCallId: call.toolCallId,
      toolName: call.kind ?? "other",
      displayName: title,
    });
    this.server.dispatch(binding.chatUri, {
      type: ActionType.ChatToolCallReady,
      turnId,
      toolCallId: call.toolCallId,
      invocationMessage: title,
      toolInput:
        call.rawInput === undefined
          ? undefined
          : JSON.stringify(call.rawInput, null, 2),
      confirmed: ToolCallConfirmationReason.NotNeeded,
    });
    this.setToolContent(binding, turnId, call);
  }

  private setToolContent(
    binding: Binding,
    turnId: string,
    update: ToolCallUpdate,
  ): void {
    const content = toolContent(update.content);
    const tracking = binding.toolCalls.get(update.toolCallId);
    if (!content || !tracking) {
      return;
    }
    tracking.content = content;
    this.server.dispatch(binding.chatUri, {
      type: ActionType.ChatToolCallContentChanged,
      turnId,
      toolCallId: update.toolCallId,
      content,
    });
  }

  private updateToolCall(
    binding: Binding,
    turnId: string,
    update: ToolCallUpdate,
  ): void {
    const tracking = binding.toolCalls.get(update.toolCallId);
    if (!tracking || tracking.phase === "done") {
      return;
    }
    if (update.title) {
      tracking.title = update.title;
    }
    if (update.status === "completed" || update.status === "failed") {
      tracking.phase = "done";
      this.server.dispatch(binding.chatUri, {
        type: ActionType.ChatToolCallComplete,
        turnId,
        toolCallId: update.toolCallId,
        result: {
          success: update.status === "completed",
          pastTenseMessage: tracking.title,
          content: toolContent(update.content) ?? tracking.content,
          ...(update.status === "failed"
            ? { error: { message: tracking.title } }
            : {}),
        },
      });
      return;
    }
    if (tracking.phase !== "running") {
      return;
    }
    if (update.title) {
      this.server.dispatch(binding.chatUri, {
        type: ActionType.ChatToolCallReady,
        turnId,
        toolCallId: update.toolCallId,
        invocationMessage: tracking.title,
        confirmed: ToolCallConfirmationReason.NotNeeded,
      });
    }
    this.setToolContent(binding, turnId, update);
  }

  private onPermissionRequest(
    binding: Binding,
    request: {
      requestId: string;
      toolCall: ToolCallUpdate;
      options: PermissionOption[];
    },
  ): void {
    const turnId = binding.turnId;
    if (!turnId) {
      return; // the webview frontend owns turns it started
    }
    const { toolCall } = request;
    if (!binding.toolCalls.has(toolCall.toolCallId)) {
      this.startToolCall(binding, turnId, toolCall);
    }
    const tracking = binding.toolCalls.get(toolCall.toolCallId)!;
    if (toolCall.title) {
      tracking.title = toolCall.title;
    }
    tracking.phase = "pending";
    tracking.permission = {
      requestId: request.requestId,
      options: request.options,
    };
    this.server.dispatch(binding.chatUri, {
      type: ActionType.ChatToolCallReady,
      turnId,
      toolCallId: toolCall.toolCallId,
      invocationMessage: tracking.title,
      confirmationTitle: tracking.title,
      options: request.options.map(option => ({
        id: option.optionId,
        label: option.name,
        kind: option.kind.startsWith("allow")
          ? ConfirmationOptionKind.Approve
          : ConfirmationOptionKind.Deny,
      })),
    });
  }

  dispose(): void {
    this.server.dispose();
  }
}
