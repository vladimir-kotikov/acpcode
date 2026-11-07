// node --test src/ahp/acpBridge.test.ts
import type { SessionInfo, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  ActionType,
  ChatSourceKind,
  type ChatState,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentClient, SessionListChanges } from "../acp/agentClient.ts";
import type { AgentConnectionPool } from "../acp/agentPool.ts";
import type { AgentConfig } from "../acp/agents/config.ts";
import { AcpAgentHost } from "./acpBridge.ts";
import type { AhpServerHooks } from "./server.ts";

const agent: AgentConfig = { name: "Claude", kind: "claude" };
const SESSION = "ahp-session:/acp-claude/s1";
const CHAT = "ahp-chat:/acp-claude/s1";

/** A bridge whose `s1` replays one turn ending in agent message `m1`. */
function setup(directories: Record<string, string[]> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const updateListeners: ((e: {
    sessionId: string;
    update: SessionUpdate;
  }) => void)[] = [];
  const replay = (sessionId: string, update: SessionUpdate) =>
    updateListeners.forEach(l => l({ sessionId, update }));
  const disposable = { dispose: () => undefined };
  const client = {
    canSendImages: () => false,
    canIndexSessions: () => true,
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
    resumeSession: (...args: unknown[]) => {
      calls.push({ method: "resumeSession", args });
      return Promise.resolve();
    },
  } as unknown as AgentClient;
  const pool = {
    connect: () => Promise.resolve(client),
    get: () => undefined,
  } as unknown as AgentConnectionPool;

  const saved: Record<string, string[]>[] = [];
  const host = new AcpAgentHost(
    pool,
    { appendLine: () => undefined } as never,
    {
      agents: () => [agent],
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
    ).onListChanges(agent, {
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
  return { host, hooks, calls, saved, notified, listChanged, clientAction };
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
  listChanged({ removed: ["s1"] });

  assert.deepEqual(
    notified.map(n => n.method),
    ["root/sessionAdded", "root/sessionSummaryChanged", "root/sessionRemoved"],
  );
  const changes = notified[1].params.changes as Record<string, unknown>;
  assert.equal(changes.title, "Renamed");
  // A row can't say what chats the session has, and Chat owns its directories.
  assert.equal("chats" in changes, false);
  assert.equal("workingDirectories" in changes, false);
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
