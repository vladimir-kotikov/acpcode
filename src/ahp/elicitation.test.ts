// node --test src/ahp/elicitation.test.ts
import type { ElicitationSchema } from "@agentclientprotocol/sdk";
import {
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  type ChatInputAnswer,
  type ChatInputAnswerValue,
} from "@microsoft/agent-host-protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import { elicitationResponseOf, inputRequestOf } from "./elicitation.ts";

// What claude-agent-acp 0.101.1 sends for AskUserQuestion: each question is a
// select followed by its "Other" box.
const askUserQuestion: ElicitationSchema = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Database",
      description: "Which database?",
      oneOf: [
        { const: "Postgres", title: "Postgres", description: "Relational" },
        { const: "Redis", title: "Redis" },
      ],
    },
    question_0_custom: {
      type: "string",
      title: "Other",
      description: "Type your own answer (optional).",
    },
    question_1: {
      type: "array",
      title: "Features",
      description: "Which features?",
      items: {
        anyOf: [
          { const: "Auth", title: "Auth" },
          { const: "Billing", title: "Billing" },
        ],
      },
    },
    question_1_custom: { type: "string", title: "Other" },
  },
};

const submitted = (value: ChatInputAnswerValue): ChatInputAnswer => ({
  state: ChatInputAnswerState.Submitted,
  value,
});

test("a select and its Other box are one question that also takes typed text", () => {
  const request = inputRequestOf("r1", "Questions", askUserQuestion);

  assert.deepEqual(request, {
    id: "r1",
    message: "Questions",
    questions: [
      {
        id: "question_0",
        title: "Database",
        message: "Which database?",
        kind: ChatInputQuestionKind.SingleSelect,
        options: [
          { id: "Postgres", label: "Postgres", description: "Relational" },
          { id: "Redis", label: "Redis" },
        ],
        allowFreeformInput: true,
      },
      {
        id: "question_1",
        title: "Features",
        message: "Which features?",
        kind: ChatInputQuestionKind.MultiSelect,
        options: [
          { id: "Auth", label: "Auth" },
          { id: "Billing", label: "Billing" },
        ],
        allowFreeformInput: true,
      },
    ],
  });
});

test("typed text goes to the Other box, beside or instead of the picks", () => {
  const response = elicitationResponseOf(
    askUserQuestion,
    ChatInputResponseKind.Accept,
    {
      // Chat sends text alone when nothing was picked.
      question_0: submitted({
        kind: ChatInputAnswerValueKind.Text,
        value: "SQLite",
      }),
      question_1: submitted({
        kind: ChatInputAnswerValueKind.SelectedMany,
        value: ["Auth"],
        freeformValues: ["Search"],
      }),
    },
  );

  assert.deepEqual(response, {
    action: "accept",
    content: {
      question_0_custom: "SQLite",
      question_1: ["Auth"],
      question_1_custom: "Search",
    },
  });
});

// What codex-acp 2.6.0 sends for a question with choices: its note box is
// named in `_meta`, and a choice points at it.
const codexQuestion: ElicitationSchema = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Where should it live?",
      oneOf: [
        { const: "/tmp (Recommended)", title: "/tmp (Recommended)" },
        { const: "The repo", title: "The repo" },
        {
          const: "None of the above",
          title: "None of the above",
          description: "Provide a different answer in the note field.",
        },
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
  } as ElicitationSchema["properties"],
};

test("Codex's select and its note box are one question, without the pointer choice", () => {
  const request = inputRequestOf("r1", "Codex keeps working", codexQuestion);
  const response = elicitationResponseOf(
    codexQuestion,
    ChatInputResponseKind.Accept,
    {
      question_0: submitted({
        kind: ChatInputAnswerValueKind.Selected,
        value: "The repo",
        freeformValues: ["under prototypes/"],
      }),
    },
  );

  assert.deepEqual(request.questions, [
    {
      id: "question_0",
      title: "Where should it live?",
      message: "Where should it live?",
      kind: ChatInputQuestionKind.SingleSelect,
      options: [
        { id: "/tmp (Recommended)", label: "/tmp (Recommended)" },
        { id: "The repo", label: "The repo" },
      ],
      allowFreeformInput: true,
    },
  ]);
  assert.deepEqual(response, {
    action: "accept",
    content: { question_0: "The repo", question_0_note: "under prototypes/" },
  });
});

test("typed text alone goes to Codex's note box", () => {
  const response = elicitationResponseOf(
    codexQuestion,
    ChatInputResponseKind.Accept,
    {
      question_0: submitted({
        kind: ChatInputAnswerValueKind.Text,
        value: "~/prototypes",
      }),
    },
  );

  assert.deepEqual(response, {
    action: "accept",
    content: { question_0_note: "~/prototypes" },
  });
});

test("a choice of a question's own called None of the above stays, and a note box without its select is asked alone", () => {
  const own = { const: "None of the above", title: "None of the above" };
  const request = inputRequestOf("r1", "Questions", {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Pick",
        oneOf: [{ const: "A", title: "A" }, own],
      },
      question_0_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "question_0", role: "user_note" } },
      },
      question_1: { type: "string", title: "Pick", oneOf: [own] },
      question_2_note: {
        type: "string",
        title: "Note",
        _meta: { codex: { questionId: "question_2", role: "user_note" } },
      },
    } as ElicitationSchema["properties"],
  });

  assert.deepEqual(
    request.questions?.map(q => [
      q.id,
      q.kind,
      "options" in q ? q.options?.map(o => o.id) : undefined,
    ]),
    [
      [
        "question_0",
        ChatInputQuestionKind.SingleSelect,
        ["A", "None of the above"],
      ],
      ["question_1", ChatInputQuestionKind.SingleSelect, ["None of the above"]],
      ["question_2_note", ChatInputQuestionKind.Text, undefined],
    ],
  );
});

test("a limit that isn't a number is left out", () => {
  const request = inputRequestOf("r1", "Questions", {
    type: "object",
    properties: { name: { type: "string", minLength: null } },
  } as unknown as ElicitationSchema);

  assert.deepEqual(request.questions, [
    { id: "name", message: "name", kind: ChatInputQuestionKind.Text },
  ]);
});

test("each property kind becomes its question kind, with its limits and default", () => {
  const schema: ElicitationSchema = {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", title: "Name", minLength: 1, default: "x" },
      email: { type: "string", description: "Your email", format: "email" },
      count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
      ratio: { type: "number" },
      ok: { type: "boolean", default: true },
      color: { type: "string", enum: ["red", "blue"], default: "blue" },
      tags: { type: "array", items: { enum: ["a"] }, maxItems: 1 },
      list: { type: "array", items: { type: "string" } },
    },
  };

  assert.deepEqual(inputRequestOf("r1", "Fill in", schema).questions, [
    {
      id: "name",
      title: "Name",
      message: "Name",
      required: true,
      kind: ChatInputQuestionKind.Text,
      min: 1,
      defaultValue: "x",
    },
    {
      id: "email",
      message: "Your email",
      kind: ChatInputQuestionKind.Text,
      format: "email",
    },
    {
      id: "count",
      message: "count",
      kind: ChatInputQuestionKind.Integer,
      min: 1,
      max: 5,
      defaultValue: 2,
    },
    { id: "ratio", message: "ratio", kind: ChatInputQuestionKind.Number },
    {
      id: "ok",
      message: "ok",
      kind: ChatInputQuestionKind.Boolean,
      defaultValue: true,
    },
    {
      id: "color",
      message: "color",
      kind: ChatInputQuestionKind.SingleSelect,
      options: [
        { id: "red", label: "red" },
        { id: "blue", label: "blue", recommended: true },
      ],
    },
    {
      id: "tags",
      message: "tags",
      kind: ChatInputQuestionKind.MultiSelect,
      options: [{ id: "a", label: "a" }],
      max: 1,
    },
    // No choices to pick from: typed instead.
    { id: "list", message: "list", kind: ChatInputQuestionKind.Text },
  ]);
});

test("answers are sent as their property's kind; skipped ones are left out", () => {
  const schema: ElicitationSchema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      ok: { type: "boolean" },
      color: { type: "string", enum: ["red", "blue"] },
      tags: { type: "array", items: { enum: ["a", "b"] } },
      typed: { type: "array", items: { enum: ["a"] } },
      list: { type: "array", items: { type: "string" } },
      note: { type: "string" },
    },
  };

  const response = elicitationResponseOf(schema, ChatInputResponseKind.Accept, {
    count: submitted({ kind: ChatInputAnswerValueKind.Text, value: "3" }),
    ok: submitted({ kind: ChatInputAnswerValueKind.Boolean, value: false }),
    color: submitted({ kind: ChatInputAnswerValueKind.Selected, value: "red" }),
    tags: submitted({ kind: ChatInputAnswerValueKind.Selected, value: "b" }),
    typed: submitted({ kind: ChatInputAnswerValueKind.Text, value: "c" }),
    list: submitted({ kind: ChatInputAnswerValueKind.Text, value: "d" }),
    note: { state: ChatInputAnswerState.Skipped },
  });

  assert.deepEqual(response, {
    action: "accept",
    content: {
      count: 3,
      ok: false,
      color: "red",
      tags: ["b"],
      typed: ["c"],
      list: ["d"],
    },
  });
});

test("a declined or cancelled form sends no answers", () => {
  assert.deepEqual(
    elicitationResponseOf(askUserQuestion, ChatInputResponseKind.Decline),
    { action: "decline" },
  );
  assert.deepEqual(
    elicitationResponseOf(askUserQuestion, ChatInputResponseKind.Cancel),
    { action: "cancel" },
  );
});
