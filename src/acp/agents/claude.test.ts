// node --test src/acp/agents/claude.test.ts
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolMetaOf } from "../toolMeta.ts";
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

const metaOf = (update: SessionUpdate) =>
  update.sessionUpdate === "tool_call" ||
  update.sessionUpdate === "tool_call_update"
    ? toolMetaOf(update)
    : undefined;

test("a shell call keeps Claude's tool name, and its description is its intention", () => {
  const call = claude.mapUpdate!({
    sessionUpdate: "tool_call",
    toolCallId: "b1",
    title: "npm test",
    kind: "execute",
    rawInput: { command: "npm test", description: "Run the tests" },
    _meta: { claudeCode: { toolName: "Bash" } },
  });
  // CLI 2.1.295 takes `command_description` too.
  const renamed = claude.mapUpdate!({
    sessionUpdate: "tool_call_update",
    toolCallId: "b2",
    rawInput: { command: "git status", command_description: "Show changes" },
  });

  assert.deepEqual(metaOf(call), {
    toolName: "Bash",
    intention: "Run the tests",
  });
  assert.deepEqual(metaOf(renamed), {
    toolName: undefined,
    intention: "Show changes",
  });
});

test("a command's output loses its Markdown fence", () => {
  const output = claude.mapUpdate!({
    sessionUpdate: "tool_call_update",
    toolCallId: "b1",
    content: [
      {
        type: "content",
        content: { type: "text", text: "```console\n M a.ts\n```" },
      },
    ],
  });

  assert.deepEqual(
    output.sessionUpdate === "tool_call_update" ? output.content : undefined,
    [{ type: "content", content: { type: "text", text: " M a.ts" } }],
  );
});

test("an update that isn't a tool call passes as is", () => {
  const message: SessionUpdate = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hi" },
  };

  assert.equal(claude.mapUpdate!(message), message);
});
