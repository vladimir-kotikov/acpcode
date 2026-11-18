// node --test src/acp/agents/codex.test.ts
import type { ElicitationSchema } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeCodex } from "../fakeClaude.test-util.ts";
import {
  UNANSWERED_QUESTION_NOTICE,
  codex,
  titleModels,
  titleOfReply,
} from "./codex.ts";

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

test("a title is made by the smallest families' newest models, then the default", () => {
  assert.deepEqual(
    titleModels([
      "gpt-6.2-sol",
      "gpt-5.6-terra",
      "gpt-6-luna",
      "gpt-6.1-terra",
      "gpt-6-terra",
    ]),
    ["gpt-6-luna", "gpt-6.1-terra", undefined],
  );
  assert.deepEqual(titleModels(["gpt-6-luna-mini", "gpt-6-terra"]), [
    "gpt-6-terra",
    undefined,
  ]);
  assert.deepEqual(titleModels(["gpt-6.2-sol"]), [undefined]);
});

test("a title comes from the first model the account has, the prompt on stdin", async t => {
  const cli = fakeCodex(
    t,
    `case "$*" in *gpt-6-luna*) echo "ERROR: The 'gpt-6-luna' model is not supported" >&2; exit 1;; esac`,
    "echo 'Easing skills installation'",
  );

  const title = await codex.titleOf!(
    { ...process.env, ...cli.env },
    "How do we ease skills installation?",
    ["gpt-6-luna", "gpt-6-terra"],
  );

  assert.equal(title, "Easing skills installation");
  const flags =
    "exec --ephemeral --skip-git-repo-check --sandbox read-only --config model_reasoning_effort=low";
  assert.deepEqual(cli.calls(), [
    `${flags} --model gpt-6-luna -`,
    `${flags} --model gpt-6-terra -`,
  ]);
  assert.match(cli.stdin(), /\n\nHow do we ease skills installation\?$/);
});

test("when no model makes a title, the last one's error is told", async t => {
  const cli = fakeCodex(t, 'echo "ERROR: $# args" >&2', "exit 1");

  await assert.rejects(
    codex.titleOf!({ ...process.env, ...cli.env }, "hi", ["gpt-6-luna"]),
    { message: "default model: ERROR: 8 args" },
  );
  assert.equal(cli.calls().length, 2);
});

test("a title is a reply's first line without its wrapping", () => {
  assert.equal(
    titleOfReply('**"Fix login bug."**\nMore text'),
    "Fix login bug",
  );
  assert.equal(titleOfReply("# Title"), "Title");
  assert.equal(titleOfReply("x".repeat(100)).length, 80);
  assert.equal(titleOfReply("\n"), "");
});
