// node --test src/acp/agentClient.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentClient, type SteeringResponse } from "./agentClient.ts";

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
