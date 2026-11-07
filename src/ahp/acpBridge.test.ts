// node --test src/ahp/acpBridge.test.ts
import type { SessionInfo, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  ActionType,
  ChatSourceKind,
  type ChatState,
  type SessionChatSummary,
  type SessionState,
  SessionStatus,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { AgentClient, SessionListChanges } from "../acp/agentClient.ts";
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
  }: {
    indexed?: boolean;
    /** The agent's env: a fake `claude` and its config dir. */
    claudeEnv?: Record<string, string>;
    deleteFails?: boolean;
  } = {},
) {
  const theAgent = claudeEnv ? { ...agent, env: claudeEnv } : agent;
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
    onPermissionRequest: () => disposable,
    subscribeSessionList: () => Promise.resolve("sub"),
    loadSession: (sessionId: string) => {
      replay(sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      });
      replay(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
        messageId: "m1",
      });
      return Promise.resolve(undefined);
    },
    forkSession: (...args: unknown[]) => {
      calls.push({ method: "forkSession", args });
      return Promise.resolve({ sessionId: "fork-1" });
    },
    listSessions: () => Promise.resolve(listed),
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
    // A first turn the agent never answers.
    prompt: () => new Promise(() => undefined),
    cancelPrompt: () => undefined,
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
  await settle();

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
