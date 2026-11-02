import type {
  PermissionOption,
  SessionInfo,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  ActionType,
  AhpErrorCodes,
  JsonRpcErrorCodes,
  ConfirmationOptionKind,
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
  type CreateSessionParams,
  type Message,
  type SessionState,
  type SessionSummary,
  type StateAction,
  type ToolResultContent,
} from "@microsoft/agent-host-protocol";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vscode from "vscode";
import type { AgentClient } from "../acp/agentClient.ts";
import type { AgentConnectionPool } from "../acp/agentPool.ts";
import { getAgents, type AgentConfig } from "../acp/agents/config.ts";
import type { Attachment } from "../shared/sessionViewProtocol.ts";
import { buildDiffText } from "../webview/diffText.ts";
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
}

/** One ACP session exposed as one AHP session with exactly one chat. */
interface Binding {
  readonly agent: AgentConfig;
  readonly sessionUri: string;
  readonly chatUri: string;
  readonly cwd: string;
  title: string;
  sessionId?: string;
  /** Settles once the ACP session is live on its connection (created, or its
   *  history loaded) — turns wait on it. */
  ready?: Promise<void>;
  /** True while `session/load` is replaying history: user chunks then mark
   *  turn boundaries instead of being `prompt()`'s own echo. */
  replaying: boolean;
  pendingUserText?: string;
  turnId?: string;
  turnStartedAt: number;
  markdownPartId?: string;
  reasoningPartId?: string;
  readonly toolCalls: Map<string, ToolCallTracking>;
}

/** AHP provider IDs double as URI schemes VS Code builds draft-session
 *  resources from (`<provider>:/untitled-<uuid>`), so they must be
 *  scheme-safe — agent display names aren't. */
const providerId = (agent: AgentConfig): string =>
  `acp-${agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

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

/** Exposes the configured ACP agents through an `AhpServer`, so VS Code's
 *  native Chat can drive them. Shares `AgentConnectionPool` with the webview
 *  frontend: one bridge subprocess per agent either way. */
export class AcpAgentHost implements vscode.Disposable {
  readonly server: AhpServer;
  private readonly pool: AgentConnectionPool;
  private readonly output: vscode.OutputChannel;
  private readonly bindings = new Map<string, Binding>(); // by session and chat URI
  private readonly byAcpSession = new Map<string, Binding>(); // by `${agent}\0${sessionId}`
  private readonly hookedClients = new WeakSet<AgentClient>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(pool: AgentConnectionPool, output: vscode.OutputChannel) {
    this.pool = pool;
    this.output = output;
    this.server = new AhpServer(
      {
        handlers: {
          listSessions: () => this.listSessions(),
          createSession: (params: CreateSessionParams) =>
            this.createSession(params),
          disposeSession: ({ channel }: { channel: string }) =>
            this.disposeSession(channel),
          // ponytail: ACP config options (model, mode, effort) aren't exposed
          // yet — an empty schema makes VS Code use the agent's defaults.
          resolveSessionConfig: ({
            config,
          }: {
            config?: Record<string, unknown>;
          }) => ({
            schema: { type: "object", properties: {} },
            values: config ?? {},
          }),
          sessionConfigCompletions: () => ({ items: [] }),
        },
        materialize: channel => this.materialize(channel),
        onClientAction: (channel, action) =>
          this.onClientAction(channel, action),
      },
      output,
      () => this.defaultCwd() && pathToFileURL(this.defaultCwd()).href,
    );
    this.server.create(ROOT_CHANNEL, { agents: this.agentInfos() });
    this.disposables.push(
      this.server,
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("acpcode.agents")) {
          this.server.dispatch(ROOT_CHANNEL, {
            type: ActionType.RootAgentsChanged,
            agents: this.agentInfos(),
          });
        }
      }),
    );
  }

  private agentInfos(): AgentInfo[] {
    return getAgents().map(agent => ({
      provider: providerId(agent),
      displayName: agent.name,
      description: `${agent.kind} via ACP`,
      // ponytail: one placeholder model; the agent's real model list arrives
      // as ACP config options, which aren't mapped yet.
      models: [{ id: "default", provider: providerId(agent), name: "Default" }],
    }));
  }

  private defaultCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private async connect(binding: Binding): Promise<AgentClient> {
    const client = await this.pool.connect(binding.agent, binding.cwd);
    if (!this.hookedClients.has(client)) {
      this.hookedClients.add(client);
      const agentName = binding.agent.name;
      client.onSessionUpdate(({ sessionId, update }) => {
        const target = this.byAcpSession.get(`${agentName}\0${sessionId}`);
        if (target) {
          this.onSessionUpdate(target, update);
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
  ): Binding {
    const binding: Binding = {
      agent,
      sessionUri,
      chatUri,
      cwd,
      replaying: false,
      turnStartedAt: 0,
      title: DEFAULT_CHAT_TITLE,
      toolCalls: new Map(),
    };
    this.bindings.set(sessionUri, binding);
    this.bindings.set(chatUri, binding);
    return binding;
  }

  // --- session catalogue -----------------------------------------------------

  private async listSessions(): Promise<{ items: SessionSummary[] }> {
    const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath);
    const perAgent = await Promise.all(
      getAgents().map(async agent => {
        try {
          const client = await this.pool.connect(agent, this.defaultCwd());
          const lists = await Promise.all(
            folders?.length
              ? folders.map(folder => client.listSessions(folder))
              : [client.listSessions()],
          );
          return lists.flat().map(info => this.summaryFor(agent, info));
        } catch (err) {
          this.output.appendLine(
            `[listSessions] ${agent.name}: ${describeError(err)}`,
          );
          return [];
        }
      }),
    );
    // Multi-root workspaces (e.g. git worktrees) can list one session twice.
    const items = new Map(perAgent.flat().map(s => [s.resource, s]));
    return { items: [...items.values()] };
  }

  /** Listed sessions get URIs derived from their ACP identity, so the same
   *  session keeps the same URI across listings and VS Code reloads. */
  private summaryFor(agent: AgentConfig, info: SessionInfo): SessionSummary {
    const key = `${providerId(agent)}/${encodeURIComponent(info.sessionId)}`;
    const sessionUri = `ahp-session:/${key}`;
    const chatUri = `ahp-chat:/${key}`;
    const binding =
      this.bindings.get(sessionUri) ??
      this.register(agent, sessionUri, chatUri, info.cwd);
    if (!binding.sessionId) {
      this.bind(binding, info.sessionId);
    }
    binding.title = info.title || binding.title;
    return this.summary(binding, info.updatedAt ?? new Date().toISOString());
  }

  private summary(binding: Binding, modifiedAt: string): SessionSummary {
    return {
      resource: binding.sessionUri,
      provider: providerId(binding.agent),
      title: binding.title,
      status: SessionStatus.Idle,
      createdAt: modifiedAt,
      modifiedAt,
      workingDirectories: [pathToFileURL(binding.cwd).href],
      defaultChat: binding.chatUri,
      chats: [{ resource: binding.chatUri, title: binding.title }],
    };
  }

  private sessionState(binding: Binding): SessionState {
    const { title } = binding;
    const chat: ChatSummary = {
      resource: binding.chatUri,
      title,
      status: SessionStatus.Idle,
      modifiedAt: new Date().toISOString(),
    };
    return {
      provider: providerId(binding.agent),
      title,
      status: SessionStatus.Idle,
      lifecycle: SessionLifecycle.Ready,
      activeClients: [],
      chats: [chat],
      defaultChat: binding.chatUri,
      workingDirectories: [pathToFileURL(binding.cwd).href],
    };
  }

  private chatState(binding: Binding): ChatState {
    return {
      resource: binding.chatUri,
      title: binding.title,
      status: SessionStatus.Idle,
      modifiedAt: new Date().toISOString(),
      turns: [],
    };
  }

  /** First subscribe to a listed session/chat: create its state, and for the
   *  chat, load the ACP session so its history replays into turns before the
   *  snapshot is taken. Unknown URIs (incl. VS Code's `<provider>:/untitled-…`
   *  drafts) are left alone and answer NotFound. */
  private async materialize(channel: string): Promise<void> {
    const binding = this.bindings.get(channel);
    if (!binding) {
      return;
    }
    if (!this.server.has(binding.sessionUri)) {
      this.server.create(binding.sessionUri, this.sessionState(binding));
    }
    if (channel === binding.chatUri && !this.server.has(binding.chatUri)) {
      this.server.create(binding.chatUri, this.chatState(binding));
      await this.ensureLoaded(binding);
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
        await client.loadSession(binding.sessionId!, binding.cwd);
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

  private createSession(params: CreateSessionParams): null {
    const agent = getAgents().find(a => providerId(a) === params.provider);
    if (!agent) {
      throw new AhpRequestError(
        AhpErrorCodes.ProviderNotFound,
        `Unknown provider ${params.provider}`,
      );
    }
    const directory = params.workingDirectories?.[0];
    const cwd = directory?.startsWith("file:")
      ? fileURLToPath(directory)
      : this.defaultCwd();
    const binding = this.register(
      agent,
      params.channel,
      `ahp-chat:/${randomUUID()}`,
      cwd,
    );
    this.server.create(binding.sessionUri, {
      ...this.sessionState(binding),
      lifecycle: SessionLifecycle.Creating,
    });
    this.server.create(binding.chatUri, this.chatState(binding));
    binding.ready = (async () => {
      const client = await this.connect(binding);
      const response = await client.newSession(cwd);
      this.bind(binding, response.sessionId);
    })();
    binding.ready.then(
      () =>
        this.server.dispatch(binding.sessionUri, {
          type: ActionType.SessionReady,
        }),
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
  }

  /** Forgets the session on this host only — the agent keeps its transcript,
   *  so it shows up again on the next listing. */
  private disposeSession(sessionUri: string): null {
    const binding = this.bindings.get(sessionUri);
    if (binding) {
      this.bindings.delete(binding.sessionUri);
      this.bindings.delete(binding.chatUri);
      if (binding.sessionId) {
        this.byAcpSession.delete(`${binding.agent.name}\0${binding.sessionId}`);
      }
      this.server.delete(binding.sessionUri);
      this.server.delete(binding.chatUri);
    }
    this.server.notify("root/sessionRemoved", {
      channel: ROOT_CHANNEL,
      session: sessionUri,
    });
    return null;
  }

  private setTitle(binding: Binding, title: string): void {
    binding.title = title;
    this.server.dispatch(binding.sessionUri, {
      type: ActionType.SessionTitleChanged,
      title,
    });
    // VS Code's session list shows the *chat* title, not the session's.
    this.server.dispatch(binding.sessionUri, {
      type: ActionType.SessionChatUpdated,
      chat: binding.chatUri,
      changes: { title },
    });
    this.server.notify("root/sessionSummaryChanged", {
      channel: ROOT_CHANNEL,
      session: binding.sessionUri,
      changes: { title },
    });
  }

  // --- client actions --------------------------------------------------------

  private onClientAction(channel: string, action: StateAction): void {
    const binding = this.bindings.get(channel);
    if (!binding || channel !== binding.chatUri) {
      return;
    }
    switch (action.type) {
      case ActionType.ChatTurnStarted:
        void this.runTurn(binding, action.turnId, action.message);
        return;
      case ActionType.ChatTurnCancelled:
        if (binding.sessionId) {
          this.pool.get(binding.agent.name)?.cancelPrompt(binding.sessionId);
        }
        binding.turnId = undefined;
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
    if (binding.title === DEFAULT_CHAT_TITLE && message.text.trim()) {
      this.setTitle(
        binding,
        message.text.trim().slice(0, TITLE_FROM_PROMPT_LENGTH),
      );
    }
    try {
      await (binding.ready ?? this.ensureLoaded(binding));
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
    if (!turnId) {
      return;
    }
    this.server.dispatch(binding.chatUri, {
      type,
      turnId,
      duration: Date.now() - binding.turnStartedAt,
    });
    if (binding.turnId === turnId) {
      binding.turnId = undefined;
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
      binding.turnId = undefined;
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
      // ponytail: plan, available commands, config options, usage and mode
      // updates aren't mapped yet.
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
    const content = toolContent(update.content);
    if (update.status === "completed" || update.status === "failed") {
      tracking.phase = "done";
      this.server.dispatch(binding.chatUri, {
        type: ActionType.ChatToolCallComplete,
        turnId,
        toolCallId: update.toolCallId,
        result: {
          success: update.status === "completed",
          pastTenseMessage: tracking.title,
          content,
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
    if (content) {
      this.server.dispatch(binding.chatUri, {
        type: ActionType.ChatToolCallContentChanged,
        turnId,
        toolCallId: update.toolCallId,
        content,
      });
    }
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
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
