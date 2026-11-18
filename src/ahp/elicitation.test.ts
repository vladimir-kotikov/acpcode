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
import { plainForm, type Form } from "../acp/forms.ts";
import {
  SECRET_ANSWER_WARNING,
  elicitationResponseOf,
  inputRequestOf,
} from "./elicitation.ts";

const formOf = (requestedSchema: ElicitationSchema) =>
  plainForm({ message: "Questions", requestedSchema });

// Selects that also take a typed answer, in a text property of their own.
const withTypedAnswers: Form = {
  message: "Questions",
  questions: [
    {
      key: "database",
      property: {
        type: "string",
        title: "Database",
        description: "Which database?",
        oneOf: [
          { const: "Postgres", title: "Postgres", description: "Relational" },
          { const: "Redis", title: "Redis" },
        ],
      },
      required: false,
      freeText: "database_other",
    },
    {
      key: "features",
      property: {
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
      required: false,
      freeText: "features_other",
    },
  ],
};

const submitted = (value: ChatInputAnswerValue): ChatInputAnswer => ({
  state: ChatInputAnswerState.Submitted,
  value,
});

test("a select with a free-text property takes typed text too", () => {
  const request = inputRequestOf("r1", withTypedAnswers);

  assert.deepEqual(request, {
    id: "r1",
    message: "Questions",
    questions: [
      {
        id: "database",
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
        id: "features",
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

test("typed text goes to the free-text property, beside or instead of the picks", () => {
  const response = elicitationResponseOf(
    withTypedAnswers,
    ChatInputResponseKind.Accept,
    {
      // Chat sends text alone when nothing was picked.
      database: submitted({
        kind: ChatInputAnswerValueKind.Text,
        value: "SQLite",
      }),
      features: submitted({
        kind: ChatInputAnswerValueKind.SelectedMany,
        value: ["Auth"],
        freeformValues: ["Search"],
      }),
    },
  );

  assert.deepEqual(response, {
    action: "accept",
    content: {
      database_other: "SQLite",
      features: ["Auth"],
      features_other: "Search",
    },
  });
});

test("a secret question warns its answer shows in the chat", () => {
  const request = inputRequestOf("r1", {
    message: "Questions",
    questions: [
      {
        key: "key",
        property: { type: "string", title: "API key?" },
        required: false,
        secret: true,
      },
    ],
  });

  assert.equal(
    request.questions?.[0].message,
    `API key?\n\n${SECRET_ANSWER_WARNING}`,
  );
});

test("a limit that isn't a number is left out", () => {
  const request = inputRequestOf(
    "r1",
    formOf({
      type: "object",
      properties: { name: { type: "string", minLength: null } },
    } as unknown as ElicitationSchema),
  );

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

  assert.deepEqual(inputRequestOf("r1", formOf(schema)).questions, [
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

  const response = elicitationResponseOf(
    formOf(schema),
    ChatInputResponseKind.Accept,
    {
      count: submitted({ kind: ChatInputAnswerValueKind.Text, value: "3" }),
      ok: submitted({ kind: ChatInputAnswerValueKind.Boolean, value: false }),
      color: submitted({
        kind: ChatInputAnswerValueKind.Selected,
        value: "red",
      }),
      tags: submitted({ kind: ChatInputAnswerValueKind.Selected, value: "b" }),
      typed: submitted({ kind: ChatInputAnswerValueKind.Text, value: "c" }),
      list: submitted({ kind: ChatInputAnswerValueKind.Text, value: "d" }),
      note: { state: ChatInputAnswerState.Skipped },
    },
  );

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
    elicitationResponseOf(withTypedAnswers, ChatInputResponseKind.Decline),
    { action: "decline" },
  );
  assert.deepEqual(
    elicitationResponseOf(withTypedAnswers, ChatInputResponseKind.Cancel),
    { action: "cancel" },
  );
});
