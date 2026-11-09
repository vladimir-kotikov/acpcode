// node --test src/acp/agentClient.test.ts
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { Attachment } from "../shared/sessionViewProtocol.ts";
import { AgentClient, type SteeringResponse } from "./agentClient.ts";
import { fakeAgent } from "./fakeAgent.test-util.ts";

function clientForSteering(response: SteeringResponse) {
  const client = new AgentClient("/workspace", {
    append: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  });
  const requests: { method: string; params: unknown }[] = [];
  // Install the narrow request surface used by steer() without spawning a
  // bridge process. The rest of AgentClient remains real.
  (
    client as unknown as {
      agent: {
        request: (method: string, params: unknown) => Promise<unknown>;
      };
    }
  ).agent = {
    request: async (method, params) => {
      requests.push({ method, params });
      return response;
    },
  };
  const updates: unknown[] = [];
  client.onSessionUpdate(update => updates.push(update));
  return { client, requests, updates };
}

test("steering opts into a host-owned prompt fallback and echoes injected text", async () => {
  const { client, requests, updates } = clientForSteering({
    outcome: "injected",
  });

  const response = await client.steer("s1", "keep going");

  assert.deepEqual(response, { outcome: "injected" });
  assert.deepEqual(requests, [
    {
      method: "_session/steering",
      params: {
        sessionId: "s1",
        prompt: [{ type: "text", text: "keep going" }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      },
    },
  ]);
  assert.equal(updates.length, 1);
});

test("idle steering leaves the message for the caller's normal prompt", async () => {
  const { client, updates } = clientForSteering({
    outcome: "promptRequired",
    reason: "noRunningTurn",
  });

  const response = await client.steer("s1", "send after the turn");

  assert.deepEqual(response, {
    outcome: "promptRequired",
    reason: "noRunningTurn",
  });
  assert.deepEqual(updates, []);
});

test("failed steering does not echo a message the agent did not accept", async () => {
  const { client, updates } = clientForSteering({ outcome: "failed" });

  const response = await client.steer("s1", "this was not applied");

  assert.deepEqual(response, { outcome: "failed" });
  assert.deepEqual(updates, []);
});

test("cancelling a prompt answers its session's pending permission request as cancelled", async t => {
  // Asks permission on every prompt, then reports the answer it got as a
  // message chunk and ends the turn.
  const entryPoint = fakeAgent(t, (message, send) => {
    if (message.method === "session/prompt") {
      send({
        id: `permission-${message.id}`,
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: "t1" },
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
        },
      });
    } else if (String(message.id).startsWith("permission-")) {
      send({
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: JSON.stringify(message.result.outcome),
            },
          },
        },
      });
      send({
        id: Number(String(message.id).slice("permission-".length)),
        result: { stopReason: "cancelled" },
      });
    }
  });
  const client = new AgentClient("/", {
    append: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  });
  t.after(() => client.dispose());
  await client.connect(
    {
      name: "fake",
      kind: "claude",
      env: { CLAUDE_CODE_EXECUTABLE: "/bin/false" },
    },
    entryPoint,
  );
  const answers: string[] = [];
  client.onSessionUpdate(({ update }) => {
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      answers.push(update.content.text);
    }
  });
  const resolved: string[] = [];
  client.onPermissionResolved(({ requestId }) => resolved.push(requestId));
  const asked = new Promise<{ requestId: string }>(resolve =>
    client.onPermissionRequest(resolve),
  );

  const turn = client.prompt("s1", "hi");
  const { requestId } = await asked;
  client.cancelPrompt("s2");
  const resolvedByOtherSession = [...resolved];
  client.cancelPrompt("s1");

  assert.deepEqual(resolvedByOtherSession, []);
  assert.deepEqual(resolved, [requestId]);
  assert.equal((await turn).stopReason, "cancelled");
  assert.deepEqual(answers, [JSON.stringify({ outcome: "cancelled" })]);
});

/** A client of an agent advertising `agentCapabilities`, which answers
 *  session/new with the directories it got, and session/load. */
async function clientOf(t: TestContext, agentCapabilities: object) {
  const entryPoint = fakeAgent(
    t,
    (message, send) => {
      if (message.method === "session/new") {
        send({
          id: message.id,
          result: {
            sessionId: JSON.stringify(
              message.params.additionalDirectories ?? null,
            ),
          },
        });
      } else if (message.method === "session/load") {
        send({ id: message.id, result: {} });
      }
    },
    agentCapabilities,
  );
  const client = new AgentClient("/", {
    append: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  });
  t.after(() => client.dispose());
  await client.connect(
    {
      name: "fake",
      kind: "claude",
      env: { CLAUDE_CODE_EXECUTABLE: "/bin/false" },
    },
    entryPoint,
  );
  return client;
}

test("optional session methods go only to an agent that advertises them", async t => {
  const bare = await clientOf(t, {});
  const capable = await clientOf(t, {
    loadSession: true,
    sessionCapabilities: { additionalDirectories: {} },
  });

  await assert.rejects(bare.loadSession("s1"), /doesn't support session\/load/);
  await capable.loadSession("s1");
  assert.equal((await bare.newSession("/w", ["/x"])).sessionId, "null");
  assert.equal(
    (await capable.newSession("/w", ["/x"])).sessionId,
    JSON.stringify(["/x"]),
  );
});

/** What an agent advertising `promptCapabilities` gets for `attachments`. */
async function promptedWith(
  t: TestContext,
  promptCapabilities: object,
  attachments: Attachment[],
) {
  // Answers a prompt with the blocks it got, as a message chunk.
  const entryPoint = fakeAgent(
    t,
    (message, send) => {
      if (message.method === "session/prompt") {
        send({
          method: "session/update",
          params: {
            sessionId: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: JSON.stringify(message.params.prompt),
              },
            },
          },
        });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      }
    },
    { promptCapabilities },
  );
  const client = new AgentClient("/", {
    append: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  });
  t.after(() => client.dispose());
  await client.connect(
    {
      name: "fake",
      kind: "claude",
      env: { CLAUDE_CODE_EXECUTABLE: "/bin/false" },
    },
    entryPoint,
  );
  let got: unknown;
  client.onSessionUpdate(({ update }) => {
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      got = JSON.parse(update.content.text);
    }
  });
  await client.prompt("s1", "", attachments);
  return got;
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
const notes: Attachment = {
  id: "a1",
  name: "notes.md",
  mimeType: "text/markdown",
  data: base64("# Notes"),
};

test("inline text attachments reach the agent embedded, or as text", async t => {
  assert.deepEqual(await promptedWith(t, { embeddedContext: true }, [notes]), [
    {
      type: "resource",
      resource: {
        uri: "attachment:notes.md",
        mimeType: "text/markdown",
        text: "# Notes",
      },
    },
  ]);
  assert.deepEqual(await promptedWith(t, {}, [notes]), [
    { type: "text", text: "notes.md:\n# Notes" },
  ]);
});

test("an inline image an agent can't take fails the prompt instead of vanishing", async t => {
  const image = {
    id: "a2",
    name: "shot.png",
    mimeType: "image/png",
    data: base64("png"),
  };

  await assert.rejects(promptedWith(t, {}, [image]), /can't take shot\.png/);
  await assert.rejects(
    promptedWith(t, { embeddedContext: true }, [image]),
    /can't take shot\.png/,
  );
});

test("compaction updates reach frontends as the Compact conversation tool call", async t => {
  // A live compaction streaming its summary, then one replayed terminal-first.
  const entryPoint = fakeAgent(t, (message, send) => {
    if (message.method !== "session/prompt") {
      return;
    }
    const updates = [
      {
        sessionUpdate: "compaction_update",
        compactionId: "c1",
        status: "in_progress",
      },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "c1",
        content: { type: "text", text: "Sum" },
      },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "c1",
        content: { type: "text", text: "mary" },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "c1",
        status: "completed",
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "c2",
        status: "completed",
        summary: [{ type: "text", text: "Old" }],
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "c3",
        status: "in_progress",
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "c3",
        status: "failed",
        error: "too long",
      },
      // A duplicate terminal update: the error stays.
      {
        sessionUpdate: "compaction_update",
        compactionId: "c3",
        status: "failed",
      },
      // Cancelled halfway through its summary.
      {
        sessionUpdate: "compaction_update",
        compactionId: "c4",
        status: "in_progress",
      },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "c4",
        content: { type: "text", text: "Half" },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "c4",
        status: "cancelled",
      },
    ];
    for (const update of updates) {
      send({ method: "session/update", params: { sessionId: "s1", update } });
    }
    send({ id: message.id, result: { stopReason: "end_turn" } });
  });
  const client = new AgentClient("/", {
    append: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  });
  t.after(() => client.dispose());
  await client.connect(
    {
      name: "fake",
      kind: "claude",
      env: { CLAUDE_CODE_EXECUTABLE: "/bin/false" },
    },
    entryPoint,
  );
  const got: unknown[] = [];
  client.onSessionUpdate(({ update }) => {
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const [part] = update.content ?? [];
      const text =
        part?.type === "content" && part.content.type === "text"
          ? part.content.text
          : undefined;
      got.push([update.sessionUpdate, update.toolCallId, update.status, text]);
      if (update.title) {
        assert.equal(update.title, "Compact conversation");
        assert.equal(update.kind, "think");
      }
    }
  });
  await client.prompt("s1", "hi");

  assert.deepEqual(got, [
    ["tool_call", "c1", "in_progress", undefined],
    // Chunks carry nothing: the summary so far comes with the next update.
    ["tool_call_update", "c1", undefined, undefined],
    ["tool_call_update", "c1", undefined, undefined],
    ["tool_call_update", "c1", "completed", "Summary"],
    ["tool_call", "c2", "completed", "Old"],
    ["tool_call", "c3", "in_progress", undefined],
    ["tool_call_update", "c3", "failed", "Compaction failed: too long"],
    ["tool_call_update", "c3", "failed", "Compaction failed: too long"],
    ["tool_call", "c4", "in_progress", undefined],
    ["tool_call_update", "c4", undefined, undefined],
    ["tool_call_update", "c4", "failed", "Compaction cancelled"],
  ]);
});

test("a replayed compaction summary shows as the Compact conversation tool call", async t => {
  const summary =
    "This session is being continued from a previous conversation that ran out of context.\n\nSummary: ...";
  const entryPoint = fakeAgent(t, (message, send) => {
    if (message.method !== "session/prompt") {
      return;
    }
    const pasted =
      "This session is being continued from a previous conversation, see notes.";
    for (const text of [pasted, message.params.prompt[0].text]) {
      send({
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
          },
        },
      });
    }
    send({ id: message.id, result: { stopReason: "end_turn" } });
  });
  const client = new AgentClient("/", {
    append: () => undefined,
    appendLine: () => undefined,
    dispose: () => undefined,
  });
  t.after(() => client.dispose());
  await client.connect(
    {
      name: "fake",
      kind: "claude",
      env: { CLAUDE_CODE_EXECUTABLE: "/bin/false" },
    },
    entryPoint,
  );
  const got: unknown[] = [];
  client.onSessionUpdate(({ update }) => {
    got.push(
      update.sessionUpdate === "tool_call"
        ? [update.title, update.status, update.content]
        : update.sessionUpdate,
    );
  });
  await client.prompt("s1", summary);

  assert.deepEqual(got, [
    "user_message_chunk", // our prompt's own echo is never touched
    "user_message_chunk", // a prompt without the summary's framing
    [
      "Compact conversation",
      "completed",
      [{ type: "content", content: { type: "text", text: summary } }],
    ],
  ]);
});
