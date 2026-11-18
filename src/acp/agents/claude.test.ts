// node --test src/acp/agents/claude.test.ts
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolNameOf } from "../toolNames.ts";
import { claude } from "./claude.ts";

test("AskUserQuestion's select and its Other box are one question", () => {
  // What claude-agent-acp 0.101.1 sends: each select followed by its box.
  const form = claude.formOf!({
    message: "Questions",
    requestedSchema: {
      type: "object",
      required: ["question_0"],
      properties: {
        question_0: {
          type: "string",
          oneOf: [{ const: "Postgres", title: "Postgres" }],
        },
        question_0_custom: { type: "string", title: "Other" },
        question_1: {
          type: "array",
          items: { anyOf: [{ const: "Auth", title: "Auth" }] },
        },
        question_1_custom: { type: "string", title: "Other" },
        notes_custom: { type: "string" },
      },
    },
  });

  assert.deepEqual(
    form.questions.map(q => [q.key, q.required, q.freeText]),
    [
      ["question_0", true, "question_0_custom"],
      ["question_1", false, "question_1_custom"],
      // A box without its select is asked alone.
      ["notes_custom", false, undefined],
    ],
  );
});

test("a tool call keeps Claude's name for its tool", () => {
  const call: SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "b1",
    title: "Run the tests",
    kind: "execute",
    _meta: { claudeCode: { toolName: "Bash" } },
  };
  const message: SessionUpdate = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  };

  const mapped = claude.mapUpdate!(call);

  assert.equal(
    mapped.sessionUpdate === "tool_call" ? toolNameOf(mapped) : undefined,
    "Bash",
  );
  assert.equal(claude.mapUpdate!(message), message);
});
