// node --test src/acp/agents/codex.test.ts
import type { ElicitationSchema } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNANSWERED_QUESTION_NOTICE, codex } from "./codex.ts";

const formOf = (
  properties: Record<string, unknown>,
  meta?: Record<string, unknown>,
) =>
  codex.formOf!({
    message: "Codex needs your input",
    requestedSchema: {
      type: "object",
      properties,
    } as ElicitationSchema,
    _meta: meta,
  });

const pointer = {
  const: "None of the above",
  title: "None of the above",
  description: "Provide a different answer in the note field.",
};

// What codex-acp 2.6.0 sends for a question with choices: its note box names
// the select in `_meta`, and a choice points at it.
const question = {
  question_0: {
    type: "string",
    title: "Where should it live?",
    oneOf: [
      { const: "/tmp (Recommended)", title: "/tmp (Recommended)" },
      { const: "The repo", title: "The repo" },
      pointer,
    ],
    _meta: { codex: { isOther: true, isSecret: false } },
  },
  question_0_note: {
    type: "string",
    title: "Additional answer or note",
    _meta: {
      codex: { questionId: "question_0", role: "user_note", isSecret: false },
    },
  },
};

test("a select and its note box are one question, without the choice pointing at the box", () => {
  const form = formOf(question);

  assert.deepEqual(
    form.questions.map(q => [
      q.key,
      q.freeText,
      q.property.oneOf?.map(c => c.const),
    ]),
    [["question_0", "question_0_note", ["/tmp (Recommended)", "The repo"]]],
  );
});

test("a choice of a question's own called None of the above stays, and a note box without its select is asked alone", () => {
  const own = { const: "None of the above", title: "None of the above" };
  const form = formOf({
    question_0: { type: "string", oneOf: [{ const: "A", title: "A" }, own] },
    question_0_note: {
      type: "string",
      _meta: { codex: { questionId: "question_0", role: "user_note" } },
    },
    question_1: { type: "string", oneOf: [pointer] },
    question_2_note: {
      type: "string",
      _meta: { codex: { questionId: "question_2", role: "user_note" } },
    },
  });

  assert.deepEqual(
    form.questions.map(q => [
      q.key,
      q.freeText,
      q.property.oneOf?.map(c => c.const),
    ]),
    [
      ["question_0", "question_0_note", ["A", "None of the above"]],
      // Without a note box, the pointer is the select's own.
      ["question_1", undefined, ["None of the above"]],
      ["question_2_note", undefined, undefined],
    ],
  );
});

test("a question Codex marks secret is secret", () => {
  const form = formOf({
    key: { type: "string", _meta: { codex: { isSecret: true } } },
    name: { type: "string", _meta: { codex: { isSecret: false } } },
  });

  assert.deepEqual(
    form.questions.map(q => [q.key, q.secret]),
    [
      ["key", true],
      ["name", undefined],
    ],
  );
});

test("only a question Codex goes on without has a notice for going unanswered", () => {
  assert.equal(
    formOf(question, { codex: { delivery: "async" } }).unansweredNotice,
    UNANSWERED_QUESTION_NOTICE,
  );
  assert.equal(formOf(question).unansweredNotice, undefined);
});
