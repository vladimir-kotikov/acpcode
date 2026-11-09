// node --test src/ahp/acpBridge.test.ts
import type {
  PermissionOption,
  SessionInfo,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  ActionType,
  AhpErrorCodes,
  ChatInteractivity,
  ChatSourceKind,
  PendingMessageKind,
  ResponsePartKind,
  type ChatState,
  type FileEdit,
  type SessionChatSummary,
  type SessionState,
  SessionStatus,
  type StateAction,
  ToolCallStatus,
} from "@microsoft/agent-host-protocol";
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type {
  AgentClient,
  SessionListChanges,
  SteeringResponse,
} from "../acp/agentClient.ts";
import type { AgentConnectionPool } from "../acp/agentPool.ts";
import type { AgentConfig } from "../acp/agents/config.ts";
import { AcpAgentHost } from "./acpBridge.ts";
import { fakeClaude, waitFor } from "../acp/fakeClaude.test-util.ts";
import type { AhpServerHooks } from "./server.ts";

const agent: AgentConfig = {
  name: "Claude",
  kind: "claude",
  // No `claude agents` jobs to find, and no CLI to run.
  env: {
    CLAUDE_CONFIG_DIR: "/nonexistent",
    CLAUDE_CODE_EXECUTABLE: "/bin/false",
  },
};
const SESSION = "ahp-session:/acp-claude/s1";
const CHAT = "ahp-chat:/acp-claude/s1";

/** A bridge whose `s1` replays one turn ending in agent message `m1`. */
function setup(
  directories: Record<string, string[]> = {},
  {
    indexed = true,
    claudeEnv,
    deleteFails = false,
    agentKind = "claude",
    steering,
    duringLoad,
    failedLoads = 0,
    afterReplay,
  }: {
    indexed?: boolean;
    /** The agent's env: a fake `claude` and its config dir. */
    claudeEnv?: Record<string, string>;
    deleteFails?: boolean;
    agentKind?: AgentConfig["kind"];
    /** What the agent answers a steering message; none can't steer. */
    steering?: SteeringResponse | Promise<SteeringResponse>;
    /** Runs while `s1`'s history replays. */
    duringLoad?: () => void;
    /** How many history loads fail before they work. */
    failedLoads?: number;
    /** What a load does once it has replayed the history. */
    afterReplay?: () => Promise<undefined>;
  } = {},
) {
  const theAgent = {
    ...agent,
    name: agentKind === "codex" ? "Codex" : agent.name,
    kind: agentKind,
    ...(claudeEnv && { env: claudeEnv }),
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const logged: string[] = [];
  /** What the agent's session list returns. */
  const listed: SessionInfo[] = [];
  const updateListeners: ((e: {
    sessionId: string;
    update: SessionUpdate;
  }) => void)[] = [];
  const replay = (sessionId: string, update: SessionUpdate) =>
    updateListeners.forEach(l => l({ sessionId, update }));
  const permissionListeners: ((request: {
    sessionId: string;
    requestId: string;
    toolCall: ToolCallUpdate;
    options: PermissionOption[];
  }) => void)[] = [];
  /** The agent asking permission for a tool call. */
  const askPermission = (
    request: Parameters<(typeof permissionListeners)[number]>[0],
  ) => permissionListeners.forEach(l => l(request));
  const prompts: ((result: { stopReason: string }) => void)[] = [];
  /** The agent ending its oldest unanswered prompt. */
  const endPrompt = (stopReason = "end_turn") =>
    prompts.shift()!({ stopReason });
  const disposable = { dispose: () => undefined };
  const client = {
    canSendImages: () => false,
    canIndexSessions: () => indexed,
    onSessionUpdate: (l: (typeof updateListeners)[number]) => {
      updateListeners.push(l);
      return disposable;
    },
    onSessionListChanges: () => disposable,
    onConnectionStateChanged: () => disposable,
    onPermissionRequest: (l: (typeof permissionListeners)[number]) => {
      permissionListeners.push(l);
      return disposable;
    },
    resolvePermission: (...args: unknown[]) => {
      calls.push({ method: "resolvePermission", args });
    },
    subscribeSessionList: () => Promise.resolve("sub"),
    loadSession: (sessionId: string) => {
      calls.push({ method: "loadSession", args: [sessionId] });
      if (failedLoads-- > 0) {
        return Promise.reject(new Error("load failed"));
      }
      replay(sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      });
      replay(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
        messageId: "m1",
      });
      duringLoad?.();
      return afterReplay?.() ?? Promise.resolve(undefined);
    },
    forkSession: (...args: unknown[]) => {
      calls.push({ method: "forkSession", args });
      return Promise.resolve({ sessionId: "fork-1" });
    },
    listSessions: (...args: unknown[]) => {
      calls.push({ method: "listSessions", args });
      return Promise.resolve(listed);
    },
    resumeSession: (...args: unknown[]) => {
      calls.push({ method: "resumeSession", args });
      return Promise.resolve();
    },
    archiveSession: (...args: unknown[]) => {
      calls.push({ method: "archiveSession", args });
      return Promise.resolve();
    },
    newSession: () => {
      calls.push({ method: "newSession", args: [] });
      return Promise.resolve({ sessionId: "draft" });
    },
    // Turns run until the test ends them with `endPrompt`.
    prompt: (...args: unknown[]) => {
      calls.push({ method: "prompt", args });
      return new Promise(resolve => prompts.push(resolve));
    },
    canSteer: () => steering !== undefined,
    steer: (...args: unknown[]) => {
      calls.push({ method: "steer", args });
      return Promise.resolve(steering);
    },
    cancelPrompt: (...args: unknown[]) => {
      calls.push({ method: "cancelPrompt", args });
    },
    deleteSession: (...args: unknown[]) => {
      calls.push({ method: "deleteSession", args });
      return deleteFails
        ? Promise.reject(new Error("delete failed"))
        : Promise.resolve();
    },
  } as unknown as AgentClient;
  const pool = {
    connect: () => Promise.resolve(client),
    get: () => client,
  } as unknown as AgentConnectionPool;

  const saved: Record<string, string[]>[] = [];
  const host = new AcpAgentHost(
    pool,
    { appendLine: (line: string) => logged.push(line) } as never,
    {
      agents: () => [theAgent],
      folders: () => ["/w"],
      filterByWorkspace: () => false,
      configCache: { load: () => ({}), save: () => undefined },
      imageCache: { load: () => ({}), save: () => undefined },
      directoryCache: {
        load: () => directories,
        save: cache => saved.push(structuredClone(cache)),
      },
    },
  );
  const notified: { method: string; params: Record<string, unknown> }[] = [];
  host.server.notify = (method, params) =>
    notified.push({ method, params: params as Record<string, unknown> });
  const hooks = (host.server as unknown as { hooks: AhpServerHooks }).hooks;
  const listChanged = (changes: Partial<SessionListChanges>) =>
    (
      host as unknown as {
        onListChanges(a: AgentConfig, c: SessionListChanges): void;
      }
    ).onListChanges(theAgent, {
      subscriptionId: "sub",
      sessions: [],
      removed: [],
      ...changes,
    });
  /** What a client dispatching `action` on `channel` goes through. */
  const clientAction = (channel: string, action: StateAction) => {
    const rejection = hooks.rejectClientAction?.(channel, action);
    if (!rejection) {
      host.server.dispatch(channel, action);
      hooks.onClientAction(channel, action);
    }
    return rejection;
  };
  return {
    host,
    hooks,
    calls,
    logged,
    listed,
    saved,
    notified,
    listChanged,
    clientAction,
    replay,
    askPermission,
    endPrompt,
  };
}

const row = (sessionId: string, title?: string): SessionInfo => ({
  sessionId,
  cwd: "/w",
  title,
});

const settle = () => new Promise(resolve => setImmediate(resolve));

test("list changes add, update and remove session rows", () => {
  const { notified, saved, listChanged } = setup({
    "Claude\0s1": ["/extra"],
  });

  listChanged({ sessions: [row("s1", "First")] });
  listChanged({ sessions: [row("s1", "Renamed")] });
  listChanged({ sessions: [row("s1", "Renamed")] });
  listChanged({ removed: ["s1"] });

  assert.deepEqual(
    notified.map(n => n.method),
    [
      "root/sessionAdded",
      "root/sessionSummaryChanged",
      "root/sessionSummaryChanged",
      "root/sessionRemoved",
    ],
  );
  const changes = notified[1].params.changes as Record<string, unknown>;
  assert.equal(changes.title, "Renamed");
  // Chat labels the row with its default chat's title.
  assert.deepEqual(
    (changes.chats as SessionChatSummary[]).map(c => c.title),
    ["Renamed"],
  );
  // Chat owns the session's directories; an unchanged title resends no chats.
  assert.equal("workingDirectories" in changes, false);
  assert.equal("chats" in (notified[2].params.changes as object), false);
  // The removed session's extra directories are forgotten on disk too.
  assert.deepEqual(saved.at(-1), {});
});

test("the primary working directory can't be removed or replaced", async () => {
  const { hooks, listChanged, clientAction } = setup({
    "Claude\0s1": ["/extra"],
  });
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(SESSION);

  for (const type of [
    ActionType.SessionWorkingDirectoryRemoved,
    ActionType.SessionWorkingDirectoryReplaced,
  ] as const) {
    assert.match(
      clientAction(SESSION, {
        type,
        directory: "file:///w",
        ...(type === ActionType.SessionWorkingDirectoryReplaced && {
          replacement: "file:///other",
        }),
      } as StateAction) ?? "",
      /primary working directory/,
    );
  }
  assert.equal(
    clientAction(SESSION, {
      type: ActionType.SessionWorkingDirectoryRemoved,
      directory: "file:///extra",
    }),
    undefined,
  );
});

test("an added directory resumes the idle session with the new set", async () => {
  const { hooks, calls, saved, listChanged, clientAction } = setup();
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(SESSION);

  clientAction(SESSION, {
    type: ActionType.SessionWorkingDirectorySet,
    directory: "file:///more",
  });
  await settle();

  assert.deepEqual(
    calls.filter(c => c.method === "resumeSession").map(c => c.args),
    [["s1", "/w", ["/more"]]],
  );
  assert.deepEqual(saved.at(-1), { "Claude\0s1": ["/more"] });
});

test("Codex resumes the idle session when an extra directory is added", async () => {
  const { hooks, calls, saved, listChanged, clientAction } = setup(
    {},
    { agentKind: "codex" },
  );
  const session = "ahp-session:/acp-codex/s1";
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(session);

  clientAction(session, {
    type: ActionType.SessionWorkingDirectorySet,
    directory: "file:///more",
  });
  await settle();

  assert.deepEqual(
    calls.filter(c => c.method === "resumeSession").map(c => c.args),
    [["s1", "/w", ["/more"]]],
  );
  assert.deepEqual(saved.at(-1), { "Codex\0s1": ["/more"] });
});

test("a fork branches at its turn's last agent message and isn't listed", async () => {
  const { host, hooks, calls, notified, listChanged } = setup();
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);
  const [turn] = (host.server.stateOf(CHAT) as ChatState).turns;

  await (hooks.handlers.createChat as (p: unknown) => Promise<null>)({
    channel: SESSION,
    chat: "ahp-chat:/fork",
    source: { kind: ChatSourceKind.Fork, chat: CHAT, turnId: turn.id },
  });

  assert.deepEqual(
    calls.filter(c => c.method === "forkSession").map(c => c.args),
    [["s1", "/w", { additionalDirectories: [], atMessageId: "m1" }]],
  );
  assert.equal(host.server.has("ahp-chat:/fork"), true);
  // The fork's own ACP session is a chat of s1, not a row of the list.
  const before = notified.length;
  listChanged({ sessions: [row("fork-1")] });
  assert.equal(notified.length, before);
});

test("a fork made here is its session's most recently modified chat", async () => {
  const { host, hooks, listChanged } = setup();
  listChanged({
    sessions: [{ ...row("s1"), updatedAt: "2026-01-01T00:00:00.000Z" }],
  });
  await hooks.materialize(CHAT);
  const [turn] = (host.server.stateOf(CHAT) as ChatState).turns;

  await (hooks.handlers.createChat as (p: unknown) => Promise<null>)({
    channel: SESSION,
    chat: "ahp-chat:/fork",
    source: { kind: ChatSourceKind.Fork, chat: CHAT, turnId: turn.id },
  });

  const [primary, fork] = (host.server.stateOf(SESSION) as SessionState).chats;
  assert.equal(fork.resource, "ahp-chat:/fork");
  assert.ok(fork.modifiedAt > primary.modifiedAt);
});

test("archiving a fork archives its ACP session and its catalog entry", async () => {
  const { host, hooks, calls, notified, listChanged, clientAction } = setup();
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);
  const [turn] = (host.server.stateOf(CHAT) as ChatState).turns;
  await (hooks.handlers.createChat as (p: unknown) => Promise<null>)({
    channel: SESSION,
    chat: "ahp-chat:/fork",
    source: { kind: ChatSourceKind.Fork, chat: CHAT, turnId: turn.id },
  });
  const forkStatus = () =>
    (
      notified.findLast(n => n.method === "root/sessionSummaryChanged")!.params
        .changes as { chats: SessionChatSummary[] }
    ).chats.find(c => c.resource === "ahp-chat:/fork")?.status;

  clientAction("ahp-chat:/fork", {
    type: ActionType.ChatIsArchivedChanged,
    isArchived: true,
  });
  // After looking for its `claude agents` job.
  await waitFor(() => calls.some(c => c.method === "archiveSession"));

  assert.deepEqual(
    calls.filter(c => c.method === "archiveSession").map(c => c.args),
    [["fork-1", true]],
  );
  assert.equal(forkStatus(), SessionStatus.Idle | SessionStatus.IsArchived);

  // Unarchived elsewhere: the fork's row brings the chat back.
  listChanged({ sessions: [row("fork-1")] });
  assert.equal(forkStatus(), SessionStatus.Idle);
  assert.equal(
    (host.server.stateOf("ahp-chat:/fork") as ChatState).status &
      SessionStatus.IsArchived,
    0,
  );
});

/** A row as an index-capable bridge lists it (`_meta.jetbrains.air`). */
const indexedRow = (
  sessionId: string,
  air: Record<string, unknown>,
): SessionInfo => ({
  ...row(sessionId, sessionId),
  _meta: { jetbrains: { air } },
});

const forkRow = (sessionId: string, parent: string): SessionInfo =>
  indexedRow(sessionId, { forkedFrom: parent });

type Listed = { resource: string; chats: SessionChatSummary[] };

const listSessions = (hooks: AhpServerHooks) =>
  (hooks.handlers.listSessions as () => Promise<{ items: Listed[] }>)();

/** The chats of `session` as Chat's list last heard of them. */
function lastCatalog(
  items: Listed[],
  notified: { method: string; params: Record<string, unknown> }[],
  session: string,
): SessionChatSummary[] {
  const changed = notified.findLast(
    n =>
      n.method === "root/sessionSummaryChanged" &&
      n.params.session === session &&
      "chats" in (n.params.changes as object),
  );
  return changed
    ? (changed.params.changes as { chats: SessionChatSummary[] }).chats
    : items.find(i => i.resource === session)!.chats;
}

test("listed forks are chats of their earliest listed ancestor's session", async () => {
  const { host, hooks, listed } = setup();
  listed.push(
    forkRow("f2", "f1"),
    forkRow("f1", "s1"),
    row("s1", "Root"),
    forkRow("orphan", "gone"),
  );

  const { items } = await (
    hooks.handlers.listSessions as () => Promise<{
      items: { resource: string; chats: SessionChatSummary[] }[];
    }>
  )();

  assert.deepEqual(
    items.map(i => [
      i.resource,
      // The primary chat first; the forks in the listing's order.
      [
        i.chats[0].resource,
        ...i.chats
          .slice(1)
          .map(c => c.resource)
          .sort(),
      ],
    ]),
    [
      [SESSION, [CHAT, "ahp-chat:/acp-claude/f1", "ahp-chat:/acp-claude/f2"]],
      ["ahp-session:/acp-claude/orphan", ["ahp-chat:/acp-claude/orphan"]],
    ],
  );
  // Opening a fork first still gives its session the primary chat's state.
  await hooks.materialize("ahp-chat:/acp-claude/f1");
  const session = host.server.stateOf(SESSION) as {
    defaultChat: string;
    chats: unknown[];
  };
  assert.equal(session.defaultChat, CHAT);
  assert.equal(session.chats.length, 3);
});

test("a session's chats carry their listed activity time, so Chat opens the latest", async () => {
  const { host, hooks, listed } = setup();
  listed.push(
    { ...row("s1", "Root"), updatedAt: "2026-01-01T00:00:00.000Z" },
    { ...forkRow("f1", "s1"), updatedAt: "2026-02-01T00:00:00.000Z" },
  );

  await listSessions(hooks);
  await hooks.materialize(SESSION);

  assert.deepEqual(
    (host.server.stateOf(SESSION) as SessionState).chats.map(c => [
      c.resource,
      c.modifiedAt,
    ]),
    [
      [CHAT, "2026-01-01T00:00:00.000Z"],
      ["ahp-chat:/acp-claude/f1", "2026-02-01T00:00:00.000Z"],
    ],
  );
});

test("a fork's row added or removed later adds or removes its chat", () => {
  const { notified, listChanged } = setup();
  listChanged({ sessions: [row("s1")] });
  const catalog = () =>
    (
      notified.findLast(n => n.method === "root/sessionSummaryChanged")!.params
        .changes as { chats: SessionChatSummary[] }
    ).chats.map(c => c.resource);

  listChanged({ sessions: [forkRow("f1", "s1")] });
  assert.deepEqual(catalog(), [CHAT, "ahp-chat:/acp-claude/f1"]);
  assert.equal(
    notified.filter(n => n.method === "root/sessionAdded").length,
    1,
  );

  listChanged({ removed: ["f1"] });
  assert.deepEqual(catalog(), [CHAT]);
});

test("archiving the primary chat archives the session's ACP session", async () => {
  const { hooks, calls, listChanged, clientAction } = setup();
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);

  clientAction(CHAT, {
    type: ActionType.ChatIsArchivedChanged,
    isArchived: true,
  });
  await waitFor(() => calls.some(c => c.method === "archiveSession"));

  assert.deepEqual(
    calls.filter(c => c.method === "archiveSession").map(c => c.args),
    [["s1", true]],
  );
});

test("a fork of an open fork listed later is a chat of the original session", async () => {
  const { host, hooks, notified, listChanged } = setup();
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);
  const [turn] = (host.server.stateOf(CHAT) as ChatState).turns;
  await (hooks.handlers.createChat as (p: unknown) => Promise<null>)({
    channel: SESSION,
    chat: "ahp-chat:/fork",
    source: { kind: ChatSourceKind.Fork, chat: CHAT, turnId: turn.id },
  });

  listChanged({ sessions: [forkRow("f2", "fork-1")] });

  assert.deepEqual(
    lastCatalog([], notified, SESSION).map(c => c.resource),
    [CHAT, "ahp-chat:/fork", "ahp-chat:/acp-claude/f2"],
  );
});

test("a listed fork archived elsewhere is listed as archived", async () => {
  const { hooks, listed, notified, listChanged } = setup();
  listed.push(row("s1"), forkRow("f1", "s1"));
  const { items } = await listSessions(hooks);

  listChanged({
    sessions: [indexedRow("f1", { forkedFrom: "s1", archived: true })],
  });

  const fork = lastCatalog(items, notified, SESSION).find(
    c => c.resource === "ahp-chat:/acp-claude/f1",
  );
  assert.equal(
    (fork?.status ?? 0) & SessionStatus.IsArchived,
    SessionStatus.IsArchived,
  );
});

test("a fork first listed without its parent link stays listed once the link shows up", async () => {
  const { hooks, listed } = setup();
  listed.push(row("s1"), row("f1"));
  await listSessions(hooks);
  listed.splice(0, Infinity, row("s1"), forkRow("f1", "s1"));

  const { items } = await listSessions(hooks);

  const shown = items.flatMap(i => [
    i.resource,
    ...i.chats.map(c => c.resource),
  ]);
  assert.ok(
    shown.includes("ahp-session:/acp-claude/f1") ||
      shown.includes("ahp-chat:/acp-claude/f1"),
    `f1 is gone from ${JSON.stringify(shown)}`,
  );
});

test("a listed fork that stops running is listed as idle", async () => {
  const { hooks, listed, notified, listChanged } = setup();
  listed.push(
    row("s1"),
    indexedRow("f1", { forkedFrom: "s1", state: "running" }),
  );
  const { items } = await listSessions(hooks);

  listChanged({
    sessions: [indexedRow("f1", { forkedFrom: "s1", state: "idle" })],
  });

  const fork = lastCatalog(items, notified, SESSION).find(
    c => c.resource === "ahp-chat:/acp-claude/f1",
  );
  assert.equal(fork?.status, SessionStatus.Idle);
});

const lastSummaryChange = (
  notified: { method: string; params: Record<string, unknown> }[],
) =>
  notified.findLast(n => n.method === "root/sessionSummaryChanged")!.params
    .changes as { title?: string; chats: SessionChatSummary[] };

test("a title the agent announces relabels the session's row", async () => {
  const { hooks, notified, listChanged, replay } = setup();
  listChanged({ sessions: [row("s1", "the whole first prompt")] });
  await hooks.materialize(CHAT);

  replay("s1", { sessionUpdate: "session_info_update", title: "Short title" });

  const changes = lastSummaryChange(notified);
  assert.equal(changes.title, "Short title");
  assert.deepEqual(
    changes.chats.map(c => [c.resource, c.title]),
    [[CHAT, "Short title"]],
  );
});

test("a title the agent announces for a fork relabels only its chat", async () => {
  const { host, hooks, notified, listChanged, replay } = setup();
  listChanged({ sessions: [row("s1", "Root")] });
  await hooks.materialize(CHAT);
  const [turn] = (host.server.stateOf(CHAT) as ChatState).turns;
  await (hooks.handlers.createChat as (p: unknown) => Promise<null>)({
    channel: SESSION,
    chat: "ahp-chat:/fork",
    source: { kind: ChatSourceKind.Fork, chat: CHAT, turnId: turn.id },
  });

  replay("fork-1", { sessionUpdate: "session_info_update", title: "Fork" });

  const changes = lastSummaryChange(notified);
  assert.equal("title" in changes, false);
  assert.deepEqual(
    changes.chats.map(c => [c.resource, c.title]),
    [
      [CHAT, "Root"],
      ["ahp-chat:/fork", "Fork"],
    ],
  );
});

test("a session listed as running doesn't keep its chat running", async () => {
  const { host, hooks, listChanged } = setup();
  listChanged({ sessions: [indexedRow("s1", { state: "running" })] });

  await hooks.materialize(SESSION);

  const { chats } = host.server.stateOf(SESSION) as {
    chats: { status: SessionStatus }[];
  };
  assert.equal(chats[0].status, SessionStatus.Idle);
});

test("a chat of an agent without a session index can't be archived", async () => {
  const { hooks, calls, listChanged, clientAction } = setup(
    {},
    { indexed: false },
  );
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);

  const rejection = clientAction(CHAT, {
    type: ActionType.ChatIsArchivedChanged,
    isArchived: true,
  });
  await settle();

  assert.match(rejection ?? "", /can't archive/);
  assert.equal(
    calls.some(c => c.method === "archiveSession"),
    false,
  );
});

test("deleting a session deletes its chats' ACP sessions, not an unsent draft", async () => {
  const { host, hooks, calls, listChanged } = setup();
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);
  const [turn] = (host.server.stateOf(CHAT) as ChatState).turns;
  await (hooks.handlers.createChat as (p: unknown) => Promise<null>)({
    channel: SESSION,
    chat: "ahp-chat:/fork",
    source: { kind: ChatSourceKind.Fork, chat: CHAT, turnId: turn.id },
  });
  await (hooks.handlers.createSession as (p: unknown) => Promise<null>)({
    channel: "ahp-session:/acp-claude/draft",
    provider: "acp-claude",
  });

  assert.ok(calls.some(c => c.method === "newSession"));
  const dispose = hooks.handlers.disposeSession as (p: unknown) => null;
  dispose({ channel: SESSION });
  dispose({ channel: "ahp-session:/acp-claude/draft" });
  await waitFor(
    () => calls.filter(c => c.method === "deleteSession").length >= 2,
  );
  await settle();

  assert.deepEqual(
    calls
      .filter(c => c.method === "deleteSession")
      .map(c => c.args)
      .sort(),
    [["fork-1"], ["s1"]],
  );
  assert.equal(host.server.has(CHAT), false);
});

/** `s1` listed and open, with a fork `fork-1` of its turn. */
async function withFork(t: ReturnType<typeof setup>) {
  t.listChanged({ sessions: [row("s1")] });
  await t.hooks.materialize(CHAT);
  const [turn] = (t.host.server.stateOf(CHAT) as ChatState).turns;
  await (t.hooks.handlers.createChat as (p: unknown) => Promise<null>)({
    channel: SESSION,
    chat: "ahp-chat:/fork",
    source: { kind: ChatSourceKind.Fork, chat: CHAT, turnId: turn.id },
  });
}

const deleted = (calls: { method: string; args: unknown[] }[]) =>
  calls.filter(c => c.method === "deleteSession").map(c => c.args);

test("sessions and forks gone from the listing aren't deleted on the agent", async () => {
  const t = setup();
  await withFork(t);

  t.listChanged({ removed: ["fork-1"] });
  t.listChanged({ removed: ["s1"] });
  await settle();

  assert.equal(t.host.server.has(CHAT), false);
  assert.deepEqual(deleted(t.calls), []);
});

test("deleting a fork deletes only its ACP session; the primary chat can't be", async () => {
  const t = setup();
  await withFork(t);
  const disposeChat = t.hooks.handlers.disposeChat as (p: unknown) => null;

  disposeChat({ channel: CHAT });
  disposeChat({ channel: "ahp-chat:/fork" });
  await waitFor(() => deleted(t.calls).length > 0);
  await settle();

  assert.deepEqual(deleted(t.calls), [["fork-1"]]);
});

test("a session deleted during its unanswered first turn is deleted on the agent", async () => {
  const t = setup();
  const draft = "ahp-session:/acp-claude/draft";
  await (t.hooks.handlers.createSession as (p: unknown) => Promise<null>)({
    channel: draft,
    provider: "acp-claude",
  });
  const chat = (t.host.server.stateOf(draft) as SessionState).defaultChat!;
  t.clientAction(chat, {
    type: ActionType.ChatTurnStarted,
    turnId: "t1",
    message: { text: "hello" },
  } as StateAction);
  await settle();

  (t.hooks.handlers.disposeSession as (p: unknown) => null)({
    channel: draft,
  });
  await waitFor(() => deleted(t.calls).length > 0);

  assert.deepEqual(deleted(t.calls), [["draft"]]);
});

/** A bridge listing `s1`, open, whose `claude agents` job is `abc12345`. */
async function withJob(ctx: TestContext, options = {}) {
  const claude = fakeClaude(ctx);
  claude.job("abc12345", JSON.stringify({ sessionId: "s1" }));
  const t = setup({}, { claudeEnv: claude.env, ...options });
  t.listChanged({ sessions: [row("s1")] });
  await t.hooks.materialize(CHAT);
  return { ...t, claude };
}

test("archiving a session removes its claude agents job once", async ctx => {
  const { claude, clientAction } = await withJob(ctx);

  // Chat may send both for one archive.
  clientAction(SESSION, {
    type: ActionType.SessionIsArchivedChanged,
    isArchived: true,
  });
  clientAction(CHAT, {
    type: ActionType.ChatIsArchivedChanged,
    isArchived: true,
  });
  await waitFor(() => claude.calls().includes("rm abc12345"));

  assert.deepEqual(claude.calls(), ["stop abc12345", "rm abc12345"]);
});

test("deleting a session removes its job even if its transcript can't be", async ctx => {
  const { claude, hooks, logged } = await withJob(ctx, { deleteFails: true });

  (hooks.handlers.disposeSession as (p: unknown) => null)({ channel: SESSION });
  await waitFor(() => logged.some(line => line.startsWith("[delete]")));

  assert.deepEqual(claude.calls(), ["stop abc12345", "rm abc12345"]);
});

test("a plain approve or deny picks the one-time option, never an always one", async () => {
  const t = setup();
  const draft = "ahp-session:/acp-claude/draft";
  await (t.hooks.handlers.createSession as (p: unknown) => Promise<null>)({
    channel: draft,
    provider: "acp-claude",
  });
  const chat = (t.host.server.stateOf(draft) as SessionState).defaultChat!;
  t.clientAction(chat, {
    type: ActionType.ChatTurnStarted,
    turnId: "t1",
    message: { text: "plan it" },
  } as StateAction);
  await settle();
  // Claude's options for leaving plan mode, in its order, plus a reject
  // "always" ahead of the one-time reject.
  const options: PermissionOption[] = [
    { kind: "allow_always", name: "Yes, and use auto mode", optionId: "auto" },
    { kind: "allow_once", name: "Yes, and approve edits", optionId: "default" },
    { kind: "reject_always", name: "No, and stop asking", optionId: "never" },
    { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
  ];
  const decide = (toolCallId: string, approved: boolean) => {
    t.askPermission({
      sessionId: "draft",
      requestId: `perm-${toolCallId}`,
      toolCall: { toolCallId, title: "Ready to code?" },
      options,
    });
    t.clientAction(chat, {
      type: ActionType.ChatToolCallConfirmed,
      turnId: "t1",
      toolCallId,
      approved,
    } as StateAction);
  };

  decide("approved", true);
  decide("denied", false);

  assert.deepEqual(
    t.calls.filter(c => c.method === "resolvePermission").map(c => c.args),
    [
      ["perm-approved", "default"],
      ["perm-denied", "plan"],
    ],
  );
});

/** A new session's chat with turn `t1` running. */
async function withRunningTurn(options: Parameters<typeof setup>[1] = {}) {
  const t = setup({}, options);
  const draft = "ahp-session:/acp-claude/draft";
  await (t.hooks.handlers.createSession as (p: unknown) => Promise<null>)({
    channel: draft,
    provider: "acp-claude",
  });
  const chat = (t.host.server.stateOf(draft) as SessionState).defaultChat!;
  t.clientAction(chat, {
    type: ActionType.ChatTurnStarted,
    turnId: "t1",
    startedAt: new Date().toISOString(),
    message: { text: "first" },
  } as StateAction);
  await settle();
  const pend = (kind: PendingMessageKind, id: string, text: string) =>
    t.clientAction(chat, {
      type: ActionType.ChatPendingMessageSet,
      kind,
      id,
      message: { text },
    } as StateAction);
  const state = () => t.host.server.stateOf(chat) as ChatState;
  const prompted = () =>
    t.calls.filter(c => c.method === "prompt").map(c => c.args[1]);
  return { ...t, chat, pend, state, prompted };
}

test("a queued message runs as the next turn once the running one completes", async () => {
  const t = await withRunningTurn();

  t.pend(PendingMessageKind.Queued, "q1", "second");
  await settle();
  const promptedWhileBusy = t.prompted();
  t.endPrompt();
  await settle();

  assert.deepEqual(promptedWhileBusy, ["first"]);
  assert.deepEqual(t.prompted(), ["first", "second"]);
  assert.equal(t.state().activeTurn?.message.text, "second");
  assert.equal(t.state().queuedMessages, undefined);
});

test("a queued message waits out a cancelled turn", async () => {
  const t = await withRunningTurn();

  t.pend(PendingMessageKind.Queued, "q1", "second");
  t.endPrompt("cancelled");
  await settle();

  assert.deepEqual(t.prompted(), ["first"]);
  assert.equal(t.state().queuedMessages?.length, 1);
});

test("a message queued in an idle chat runs right away", async () => {
  const t = await withRunningTurn();
  t.endPrompt();
  await settle();

  t.pend(PendingMessageKind.Queued, "q1", "second");
  await settle();

  assert.deepEqual(t.prompted(), ["first", "second"]);
});

test("a steering message the agent takes completes the turn and answers a new one", async () => {
  const t = await withRunningTurn({ steering: { outcome: "injected" } });

  t.pend(PendingMessageKind.Steering, "s1", "also this");
  await settle();
  t.replay("draft", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "on it" },
  });
  t.endPrompt();
  await settle();

  assert.deepEqual(
    t.calls.filter(c => c.method === "steer").map(c => c.args[1]),
    ["also this"],
  );
  assert.deepEqual(t.prompted(), ["first"]);
  const turns = t.state().turns;
  assert.deepEqual(
    turns.map(turn => turn.message.text),
    ["first", "also this"],
  );
  assert.equal(turns[0].responseParts.length, 0);
  assert.equal(turns[1].responseParts.length, 1);
  assert.equal(t.state().steeringMessage, undefined);
  assert.equal(t.state().activeTurn, undefined);
});

test("a steering message an agent can't take runs as the next turn", async () => {
  const t = await withRunningTurn();

  t.pend(PendingMessageKind.Steering, "s1", "also this");
  await settle();
  t.endPrompt();
  await settle();

  assert.deepEqual(t.prompted(), ["first", "also this"]);
  assert.equal(t.state().steeringMessage, undefined);
});

test("a steering message taken during a tool call waits for it to finish", async () => {
  const t = await withRunningTurn({ steering: { outcome: "injected" } });
  t.askPermission({
    sessionId: "draft",
    requestId: "perm-1",
    toolCall: { toolCallId: "tc1", title: "Run tests" },
    options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
  });

  t.pend(PendingMessageKind.Steering, "s1", "also this");
  await settle();
  const turnWhileAsking = t.state().activeTurn?.id;
  t.clientAction(t.chat, {
    type: ActionType.ChatToolCallConfirmed,
    turnId: "t1",
    toolCallId: "tc1",
    approved: true,
  } as StateAction);
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc1",
    status: "completed",
  });

  assert.equal(turnWhileAsking, "t1");
  const [first] = t.state().turns;
  assert.equal(first.id, "t1");
  assert.deepEqual(
    first.responseParts.map(part =>
      part.kind === ResponsePartKind.ToolCall
        ? part.toolCall.status
        : part.kind,
    ),
    [ToolCallStatus.Completed],
  );
  assert.equal(t.state().activeTurn?.message.text, "also this");
});

test("a cancelled turn doesn't run the queue when its steering message is back", async () => {
  let answer!: (response: SteeringResponse) => void;
  const t = await withRunningTurn({
    steering: new Promise(resolve => (answer = resolve)),
  });
  t.pend(PendingMessageKind.Queued, "q1", "second");
  t.pend(PendingMessageKind.Steering, "s1", "also this");
  await settle();

  t.clientAction(t.chat, {
    type: ActionType.ChatTurnCancelled,
    turnId: "t1",
    duration: 0,
  } as StateAction);
  t.endPrompt("cancelled");
  await settle();
  answer({ outcome: "injected" });
  await settle();

  assert.deepEqual(t.prompted(), ["first"]);
  assert.equal(t.state().steeringMessage, undefined);
  assert.equal(t.state().queuedMessages?.length, 1);
});

test("a message queued while the history replays runs after it", async () => {
  let pend = () => {};
  const t = setup({}, { duringLoad: () => pend() });
  pend = () =>
    t.clientAction(CHAT, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Queued,
      id: "q1",
      message: { text: "later" },
    } as StateAction);
  t.listChanged({ sessions: [row("s1")] });

  await t.hooks.materialize(CHAT);
  await settle();

  assert.deepEqual(
    t.calls.filter(c => c.method === "prompt").map(c => c.args[1]),
    ["later"],
  );
});

test("a steering message replaced before its turn starts is sent once that turn has", async () => {
  const t = await withRunningTurn({ steering: { outcome: "injected" } });
  t.askPermission({
    sessionId: "draft",
    requestId: "perm-1",
    toolCall: { toolCallId: "tc1", title: "Run tests" },
    options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
  });
  t.pend(PendingMessageKind.Steering, "s1", "also this");
  await settle();

  t.pend(PendingMessageKind.Steering, "s2", "and that");
  await settle();
  const steeredWhileWaiting = t.calls.filter(c => c.method === "steer").length;
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc1",
    status: "completed",
  });
  await settle();

  assert.equal(steeredWhileWaiting, 1);
  assert.deepEqual(
    t.state().turns.map(turn => turn.message.text),
    ["first", "also this"],
  );
  assert.equal(t.state().activeTurn?.message.text, "and that");
});

test("editing a request during its turn cancels it, and the edit waits for that", async () => {
  const t = await withRunningTurn();

  t.clientAction(t.chat, { type: ActionType.ChatTruncated } as StateAction);
  t.clientAction(t.chat, {
    type: ActionType.ChatTurnStarted,
    turnId: "t2",
    startedAt: new Date().toISOString(),
    message: { text: "edited" },
  } as StateAction);
  await settle();
  const promptedBeforeCancelled = t.prompted();
  t.endPrompt("cancelled");
  await settle();

  assert.deepEqual(
    t.calls.filter(c => c.method === "cancelPrompt").map(c => c.args),
    [["draft"]],
  );
  assert.deepEqual(promptedBeforeCancelled, ["first"]);
  assert.deepEqual(t.prompted(), ["first", "edited"]);
  assert.equal(t.state().activeTurn?.id, "t2");
  assert.deepEqual(t.state().turns, []);
});

test("a turn dropped while waiting for the cancelled prompt never prompts", async () => {
  const t = await withRunningTurn();
  const edit = (turnId: string, text: string) => {
    t.clientAction(t.chat, { type: ActionType.ChatTruncated } as StateAction);
    t.clientAction(t.chat, {
      type: ActionType.ChatTurnStarted,
      turnId,
      startedAt: new Date().toISOString(),
      message: { text },
    } as StateAction);
  };

  edit("t2", "edited");
  await settle();
  t.replay("draft", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "tail of first" },
  });
  t.askPermission({
    sessionId: "draft",
    requestId: "perm-late",
    toolCall: { toolCallId: "late", title: "Late" },
    options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
  });
  const editedParts = t.state().activeTurn?.responseParts;
  edit("t3", "edited again");
  t.endPrompt("cancelled");
  await settle();

  assert.deepEqual(t.prompted(), ["first", "edited again"]);
  assert.deepEqual(editedParts, []);
  assert.deepEqual(
    t.calls.filter(c => c.method === "resolvePermission").map(c => c.args),
    [["perm-late", null]],
  );
  assert.equal(t.state().activeTurn?.id, "t3");
});

test("a turn in a chat whose history didn't load resumes the session instead", async () => {
  const t = setup({}, { failedLoads: 1 });
  t.listChanged({ sessions: [row("s1")] });
  await assert.rejects(t.hooks.materialize(CHAT));

  t.clientAction(CHAT, {
    type: ActionType.ChatTurnStarted,
    turnId: "t1",
    startedAt: new Date().toISOString(),
    message: { text: "still there?" },
  } as StateAction);
  await settle();

  assert.deepEqual(
    t.calls
      .filter(c => /^(load|resume)Session$/.test(c.method))
      .map(c => c.method),
    ["loadSession", "resumeSession"],
  );
  assert.deepEqual(
    t.calls.filter(c => c.method === "prompt").map(c => c.args[1]),
    ["still there?"],
  );
  const chat = t.host.server.stateOf(CHAT) as ChatState;
  assert.equal(chat.activeTurn?.id, "t1");
  assert.deepEqual(chat.turns, []);
});

test("a turn the agent stops short says why", async () => {
  const t = await withRunningTurn();

  t.endPrompt("max_tokens");
  await settle();

  const [turn] = t.state().turns;
  assert.deepEqual(turn.responseParts, [
    {
      kind: ResponsePartKind.SystemNotification,
      content: "Stopped: the response reached the token limit.",
    },
  ]);
});

test("creating a session that already exists fails without a second ACP session", async () => {
  const t = setup();
  const create = t.hooks.handlers.createSession as (
    p: unknown,
  ) => Promise<null>;
  const params = {
    channel: "ahp-session:/acp-claude/draft",
    provider: "acp-claude",
  };
  await create(params);

  await assert.rejects(
    async () => create(params),
    (err: { code?: number }) => err.code === AhpErrorCodes.SessionAlreadyExists,
  );
  assert.equal(t.calls.filter(c => c.method === "newSession").length, 1);
});

test("a simple attachment reaches the agent as its model representation", async () => {
  const t = setup();
  const draft = "ahp-session:/acp-claude/draft";
  await (t.hooks.handlers.createSession as (p: unknown) => Promise<null>)({
    channel: draft,
    provider: "acp-claude",
  });
  const chat = (t.host.server.stateOf(draft) as SessionState).defaultChat!;

  t.clientAction(chat, {
    type: ActionType.ChatTurnStarted,
    turnId: "t1",
    startedAt: new Date().toISOString(),
    message: {
      text: "look",
      attachments: [
        { type: "simple", label: "Problems", modelRepresentation: "2 errors" },
      ],
    },
  } as StateAction);
  await settle();

  const [prompt] = t.calls.filter(c => c.method === "prompt");
  assert.deepEqual(prompt.args[2], [
    {
      id: (prompt.args[2] as { id: string }[])[0].id,
      name: "Problems",
      mimeType: "text/plain",
      data: Buffer.from("2 errors").toString("base64"),
    },
  ]);
});

test("an edit shows as a file edit whose sides Chat reads from the host", async () => {
  const t = await withRunningTurn();
  const read = t.hooks.handlers.resourceRead as (p: unknown) => {
    data: string;
  };

  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "e1",
    title: "Edit a.txt",
    kind: "edit",
    content: [
      {
        type: "diff",
        path: "/w/a.txt",
        oldText: "a\nb\n",
        newText: "a\nc\nd\n",
      },
    ],
  });

  const part = t.state().activeTurn?.responseParts[0];
  assert.equal(part?.kind, ResponsePartKind.ToolCall);
  const [edit] = (part as { toolCall: { content: FileEdit[] } }).toolCall
    .content;
  assert.equal(edit.before?.uri, "file:///w/a.txt");
  // Plain paths: Chat sends back what its URI parser makes of them.
  assert.match(edit.after!.content.uri, /^acpcode-content:\/[0-9a-f]+$/);
  assert.deepEqual(edit.diff, { added: 2, removed: 1 });
  assert.equal(read({ uri: edit.before!.content.uri }).data, "a\nb\n");
  assert.equal(read({ uri: edit.after!.content.uri }).data, "a\nc\nd\n");

  (t.hooks.handlers.disposeSession as (p: unknown) => null)({
    channel: "ahp-session:/acp-claude/draft",
  });
  assert.throws(() => read({ uri: edit.after!.content.uri }), /not found/);
});

test("a tool call keeps the agent's tool name and a failure its error", async () => {
  const t = await withRunningTurn();

  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "b1",
    title: "Run the tests",
    kind: "execute",
    _meta: { claudeCode: { toolName: "Bash" } },
  });
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    status: "failed",
    rawOutput: [{ type: "text", text: "npm ERR! missing script: tests" }],
  });

  const part = t.state().activeTurn?.responseParts[0] as {
    toolCall: { toolName: string; error?: { message: string } };
  };
  assert.equal(part.toolCall.toolName, "Bash");
  assert.equal(part.toolCall.error?.message, "npm ERR! missing script: tests");
});

test("a shell command becomes a terminal once Chat can label it", async () => {
  const t = await withRunningTurn();
  const toolCall = (id: string) =>
    t
      .state()
      .activeTurn?.responseParts.map(
        p =>
          (
            p as {
              toolCall: {
                toolCallId: string;
                toolInput?: string;
                intention?: string;
                _meta?: object;
              };
            }
          ).toolCall,
      )
      .find(c => c.toolCallId === id);
  const terminal = { toolKind: "terminal" };

  // Claude streams the input, the command before its description.
  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "b1",
    title: "Terminal",
    kind: "execute",
    rawInput: {},
  });
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    rawInput: { command: "npm test" },
  });
  const partial = { ...toolCall("b1") };
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    rawInput: { command: "npm test", description: "Run the tests" },
  });
  // Codex sends it whole, without a description.
  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "npm test",
    kind: "execute",
    rawInput: { command: "npm test", cwd: "/w" },
  });
  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "n1",
    title: "Terminal",
    kind: "execute",
    rawInput: {},
  });
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "n1",
    rawInput: { command: "ls" },
  });
  const undescribed = { ...toolCall("n1") };
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "n1",
    status: "completed",
  });
  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "d1",
    title: "A dynamic tool",
    kind: "execute",
    rawInput: { arguments: {} },
  });

  assert.deepEqual(JSON.parse(partial.toolInput!), { command: "npm test" });
  assert.equal(partial._meta, undefined);
  assert.deepEqual(toolCall("b1")!._meta, terminal);
  assert.equal(toolCall("b1")!.intention, "Run the tests");
  assert.deepEqual(toolCall("c1")!._meta, terminal);
  assert.equal(undescribed._meta, undefined);
  assert.deepEqual(toolCall("n1")!._meta, terminal);
  assert.equal(toolCall("d1")!._meta, undefined);
});

test("a shell command is titled with its input's description, not its command line", async () => {
  const t = await withRunningTurn();
  const call = (id: string) =>
    t
      .state()
      .activeTurn?.responseParts.map(
        p =>
          (
            p as {
              toolCall: {
                toolCallId: string;
                invocationMessage?: string;
                intention?: string;
                _meta?: object;
                confirmationTitle?: string;
                pastTenseMessage?: string;
              };
            }
          ).toolCall,
      )
      .find(c => c.toolCallId === id);
  const titleOf = (id: string) => call(id)?.invocationMessage;

  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "b1",
    title: "Terminal",
    kind: "execute",
    rawInput: {},
  });
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    title: "npm test -- --long --flags",
    rawInput: {
      command: "npm test -- --long --flags",
      description: "Run the tests",
    },
  });
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    title: "npm test -- --long --flags",
  });
  t.replay("draft", {
    sessionUpdate: "tool_call",
    toolCallId: "i1",
    title: "Create an issue",
    kind: "other",
    rawInput: { description: "A long issue body" },
  });
  t.askPermission({
    sessionId: "draft",
    requestId: "perm-p1",
    toolCall: {
      toolCallId: "p1",
      title: "rm -rf build",
      kind: "execute",
      rawInput: { command: "rm -rf build", description: "Remove the build" },
    },
    options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
  });
  const asked = { ...call("p1") };
  t.replay("draft", {
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    status: "completed",
  });

  assert.equal(titleOf("b1"), "Run the tests");
  assert.equal(titleOf("i1"), "Create an issue");
  assert.equal(asked.confirmationTitle, "Remove the build");
  // What Chat's terminal card is labelled with.
  assert.equal(asked.intention, "Remove the build");
  assert.deepEqual(asked._meta, { toolKind: "terminal" });
  assert.equal(call("b1")?.intention, "Run the tests");
  assert.equal(call("i1")?.intention, undefined);
  assert.equal(call("b1")?.pastTenseMessage, "Run the tests");
});

test("a chat Chat resubscribes to before any listing is restored from the agent's", async () => {
  const { host, hooks, listed, calls } = setup();
  listed.push(row("s1", "Root"), forkRow("f1", "s1"));

  await Promise.all([
    hooks.materialize("ahp-chat:/acp-claude/f1"),
    hooks.materialize("ahp-session:/acp-claude/s1"),
  ]);
  await hooks.materialize("ahp-chat:/acp-nope/s1");
  await hooks.materialize("ahp-chat:/acp-claude/gone");
  await hooks.materialize("ahp-chat:/acp-claude/gone");

  assert.equal(host.server.has("ahp-chat:/acp-claude/f1"), true);
  // A fork's session is its parent's.
  assert.equal(host.server.has(SESSION), true);
  assert.deepEqual(
    calls.filter(c => c.method === "loadSession").map(c => c.args[0]),
    ["f1", "s1"],
  );
  assert.equal(host.server.has("ahp-chat:/acp-nope/s1"), false);
  assert.equal(host.server.has("ahp-chat:/acp-claude/gone"), false);
  // Once for both chats, and once for the one it doesn't list.
  assert.equal(calls.filter(c => c.method === "listSessions").length, 2);
});

test("a load the agent never answers ends its replayed turn and keeps the queue", async () => {
  const { host, hooks, clientAction, calls, listChanged } = setup(
    {},
    { afterReplay: () => new Promise<undefined>(() => {}) },
  );
  host.loadTimeoutMs = 20;
  listChanged({ sessions: [row("s1")] });

  const loading = hooks.materialize(CHAT);
  await waitFor(() => host.server.has(CHAT));
  await settle();
  clientAction(CHAT, {
    type: ActionType.ChatPendingMessageSet,
    kind: PendingMessageKind.Queued,
    id: "q1",
    message: { text: "after" },
  } as StateAction);

  await assert.rejects(loading, /didn't load the session/);
  const state = host.server.stateOf(CHAT) as ChatState;
  assert.equal(state.activeTurn, undefined);
  assert.equal(state.turns.at(-1)?.message.text, "hello");
  assert.equal(state.queuedMessages?.length, 1);
  assert.deepEqual(
    calls.filter(c => c.method === "prompt"),
    [],
  );
});

test("cancelling a turn that isn't the running one leaves the running one be", async () => {
  const t = await withRunningTurn();

  t.clientAction(t.chat, {
    type: ActionType.ChatTurnCancelled,
    turnId: "a-previous-hosts",
  } as StateAction);
  await settle();

  assert.deepEqual(
    t.calls.filter(c => c.method === "cancelPrompt"),
    [],
  );
  assert.equal(t.state().activeTurn?.id, "t1");
});

test("a load's history settles once the agent says it has replayed, not when it answers", async () => {
  let replay!: ReturnType<typeof setup>["replay"];
  const t = setup(
    {},
    {
      afterReplay: () => {
        replay("s1", {
          sessionUpdate: "session_info_update",
          _meta: { jetbrains: { air: { loadReplayEnd: true } } },
        });
        return new Promise<undefined>(() => {});
      },
    },
  );
  replay = t.replay;
  t.host.loadTimeoutMs = 100;
  t.listChanged({ sessions: [row("s1")] });

  const loading = t.hooks.materialize(CHAT);
  await waitFor(
    () =>
      (t.host.server.stateOf(CHAT) as ChatState | undefined)?.turns.length ===
      1,
  );
  const state = t.host.server.stateOf(CHAT) as ChatState;

  assert.equal(state.activeTurn, undefined);
  assert.equal(state.turns.at(-1)?.message.text, "hello");
  await assert.rejects(loading);
});

test("a load retried after one timed out replays the history once", async () => {
  let loads = 0;
  const { host, hooks, listChanged } = setup(
    {},
    {
      afterReplay: () =>
        loads++ === 0
          ? new Promise<undefined>(() => {})
          : Promise.resolve(undefined),
    },
  );
  host.loadTimeoutMs = 20;
  listChanged({ sessions: [row("s1")] });

  await assert.rejects(hooks.materialize(CHAT));
  await hooks.materialize(CHAT);

  assert.deepEqual(
    (host.server.stateOf(CHAT) as ChatState).turns.map(t => t.message.text),
    ["hello"],
  );
});

test("a chat whose session runs in a background job opens read-only with its history", async ctx => {
  const claude = fakeClaude(ctx);
  claude.running("s1");
  const { host, hooks, listChanged, clientAction } = setup(
    {},
    {
      claudeEnv: claude.env,
      afterReplay: () =>
        Promise.reject(new Error("That session is running in the background")),
    },
  );
  listChanged({ sessions: [row("s1")] });

  await hooks.materialize(CHAT);
  const state = host.server.stateOf(CHAT) as ChatState;
  const rejection = clientAction(CHAT, {
    type: ActionType.ChatTurnStarted,
    turnId: "t1",
    startedAt: new Date().toISOString(),
    message: { text: "hi" },
  } as StateAction);

  assert.equal(state.interactivity, ChatInteractivity.ReadOnly);
  assert.deepEqual(
    state.turns.map(t => t.message.text),
    ["hello"],
  );
  assert.match(rejection ?? "", /running in background job s1/);
});

test("a watched chat follows its session, and opens as Chat's own once its owner is gone", async ctx => {
  const claude = fakeClaude(ctx);
  const gone = claude.running("s1", "interactive");
  const { host, hooks, listChanged, calls } = setup(
    {},
    { claudeEnv: claude.env },
  );
  host.server.isSubscribed = () => true;
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);

  // A turn there ends, and the session's row says so.
  listChanged({ sessions: [{ ...row("s1"), updatedAt: "later" }] });
  await waitFor(
    () => calls.filter(c => c.method === "loadSession").length === 2,
  );
  assert.deepEqual(
    (host.server.stateOf(CHAT) as ChatState).turns.map(t => t.message.text),
    ["hello"],
  );
  gone();
  hooks.unsubscribed?.(CHAT);
  await hooks.materialize(CHAT);

  assert.equal(
    (host.server.stateOf(CHAT) as ChatState).interactivity,
    undefined,
  );
  assert.deepEqual(
    (host.server.stateOf(CHAT) as ChatState).turns.map(t => t.message.text),
    ["hello"],
  );
});

test("a watched chat subscribed to with its session at once keeps its history", async ctx => {
  const claude = fakeClaude(ctx);
  claude.running("s1");
  const { host, hooks, listChanged } = setup({}, { claudeEnv: claude.env });
  listChanged({ sessions: [row("s1")] });

  await Promise.all([hooks.materialize(SESSION), hooks.materialize(CHAT)]);

  assert.deepEqual(
    (host.server.stateOf(CHAT) as ChatState).turns.map(t => t.message.text),
    ["hello"],
  );
});

test("a watched chat's session changing while it loads loads it once more after", async ctx => {
  const claude = fakeClaude(ctx);
  claude.running("s1");
  let finish: (() => void) | undefined;
  const { host, hooks, listChanged, calls } = setup(
    {},
    {
      claudeEnv: claude.env,
      afterReplay: () =>
        finish
          ? Promise.resolve(undefined)
          : new Promise<undefined>(resolve => {
              finish = () => resolve(undefined);
            }),
    },
  );
  host.server.isSubscribed = () => true;
  listChanged({ sessions: [row("s1")] });
  const loading = hooks.materialize(CHAT);
  await waitFor(() => !!finish);
  const loads = () => calls.filter(c => c.method === "loadSession").length;

  listChanged({ sessions: [{ ...row("s1"), updatedAt: "later" }] });
  listChanged({ sessions: [{ ...row("s1"), updatedAt: "later still" }] });
  const whileLoading = loads();
  finish!();
  await loading;
  await waitFor(() => loads() === 2);
  await settle();

  assert.equal(whileLoading, 1);
  assert.equal(loads(), 2);
  assert.deepEqual(
    (host.server.stateOf(CHAT) as ChatState).turns.map(t => t.message.text),
    ["hello"],
  );
});

test("a watched chat nobody shows any more is forgotten, not loaded again", async ctx => {
  const claude = fakeClaude(ctx);
  claude.running("s1");
  const { host, hooks, listChanged, calls } = setup(
    {},
    { claudeEnv: claude.env },
  );
  listChanged({ sessions: [row("s1")] });
  await hooks.materialize(CHAT);

  listChanged({ sessions: [{ ...row("s1"), updatedAt: "later" }] });
  await settle();

  assert.equal(calls.filter(c => c.method === "loadSession").length, 1);
  assert.equal(host.server.has(CHAT), false);
});

test("a deleted session's row arriving while the agent deletes it doesn't bring it back", async () => {
  const t = setup();
  t.listChanged({ sessions: [row("s1")] });
  await t.hooks.materialize(CHAT);

  (t.hooks.handlers.disposeSession as (p: unknown) => null)({
    channel: SESSION,
  });
  // A job stopping writes its transcript, so the index sends the row again.
  t.listChanged({ sessions: [row("s1")] });
  t.listed.push(row("s1"));
  const { items } = await (
    t.hooks.handlers.listSessions as () => Promise<{ items: unknown[] }>
  )();
  await waitFor(() => deleted(t.calls).length > 0);

  assert.deepEqual(items, []);
  assert.equal(t.host.server.has(SESSION), false);
  assert.equal(t.notified.at(-1)?.method, "root/sessionRemoved");
});

test("a session the agent couldn't delete is listed again", async () => {
  const t = setup({}, { deleteFails: true });
  t.listChanged({ sessions: [row("s1")] });
  await t.hooks.materialize(CHAT);

  (t.hooks.handlers.disposeSession as (p: unknown) => null)({
    channel: SESSION,
  });
  await waitFor(() => t.logged.some(line => line.startsWith("[delete]")));
  t.listChanged({ sessions: [row("s1")] });

  assert.equal(t.notified.at(-1)?.method, "root/sessionAdded");
});

test("a deleted session whose row comes back after its delete is deleted again", async () => {
  const t = setup();
  t.listChanged({ sessions: [row("s1")] });
  await t.hooks.materialize(CHAT);
  (t.hooks.handlers.disposeSession as (p: unknown) => null)({
    channel: SESSION,
  });
  await waitFor(() => deleted(t.calls).length > 0);
  await settle();

  // A stopped job's last write recreated the transcript.
  t.listChanged({ sessions: [row("s1")] });
  t.listChanged({ sessions: [row("s1")] });
  await settle();

  assert.deepEqual(deleted(t.calls), [["s1"], ["s1"]]);
  assert.equal(t.notified.at(-1)?.method, "root/sessionRemoved");
});
