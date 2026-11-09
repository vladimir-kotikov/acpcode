// node --test src/acp/agentClient.test.ts
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
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
