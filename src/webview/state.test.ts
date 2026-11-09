// node --test src/webview/state.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, reduce } from "./state.ts";

const meta = {
  agentName: "Claude",
  sessionId: "s1",
  cwd: "/w",
  canSteer: false,
  canAttachImages: false,
};

test("a refused prompt leaves a note; a normal end doesn't", () => {
  const state = { ...initialState, meta, busy: true };

  const refused = reduce(state, {
    type: "promptStopped",
    sessionId: "s1",
    stopReason: "refusal",
  });
  const ended = reduce(state, {
    type: "promptStopped",
    sessionId: "s1",
    stopReason: "end_turn",
  });

  assert.equal(refused.busy, false);
  assert.deepEqual(
    refused.blocks.map(block => block.type === "note" && block.text),
    ["Stopped: the agent refused to continue."],
  );
  assert.deepEqual(ended.blocks, []);
});
