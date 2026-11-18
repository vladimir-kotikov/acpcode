// ACP form elicitations ⇄ AHP input requests. Both follow MCP's
// elicitation schema: each property of the requested schema is a question,
// keyed by the property's name.
import type {
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";
import {
  ChatInputAnswerState,
  ChatInputAnswerValueKind,
  ChatInputQuestionKind,
  ChatInputResponseKind,
  type ChatInputAnswer,
  type ChatInputOption,
  type ChatInputQuestion,
  type ChatInputRequest,
} from "@microsoft/agent-host-protocol";

/** A requested schema's property, any of ACP's kinds. */
interface Property {
  type?: string;
  title?: string | null;
  description?: string | null;
  default?: unknown;
  format?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  minimum?: number | null;
  maximum?: number | null;
  minItems?: number | null;
  maxItems?: number | null;
  enum?: string[] | null;
  oneOf?: Choice[] | null;
  items?: { enum?: string[] | null; anyOf?: Choice[] | null };
  _meta?: { codex?: { role?: string; questionId?: string } } | null;
}

interface Choice {
  const: string;
  title: string;
  description?: string | null;
}

interface Field {
  key: string;
  property: Property;
  /** The text property that takes this select's "Other" answer. */
  custom?: string;
  /** Whether that text property is Codex's note box, whose select has a
   *  choice pointing at it: left out, as the question takes typed text. */
  codexNote?: boolean;
}

/** The choice codex-acp adds to a select that has a note box, unless one of
 *  the select's own is called so. */
const isCodexNotePointer = (choice: ChatInputOption) =>
  choice.id === "None of the above" &&
  choice.description === "Provide a different answer in the note field.";

const choicesOf = (property: Property): ChatInputOption[] | undefined => {
  const titled =
    property.type === "array" ? property.items?.anyOf : property.oneOf;
  const plain =
    property.type === "array" ? property.items?.enum : property.enum;
  const choices =
    titled?.map(choice => ({
      id: choice.const,
      label: choice.title,
      ...(choice.description && { description: choice.description }),
    })) ?? plain?.map(value => ({ id: value, label: value }));
  return property.type === "string" || property.type === "array"
    ? choices
    : undefined;
};

/** The schema's questions. A select and the text property that takes its
 *  "Other" answer are one question that also takes typed text: Claude's
 *  AskUserQuestion form follows each select with a `<key>_custom` box, and
 *  Codex's names its note box's select in `_meta`. */
function fieldsOf(schema: ElicitationSchema): Field[] {
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  const isText = (property?: Property) =>
    property?.type === "string" && !choicesOf(property)?.length;
  const notes = new Map<string, string>();
  for (const [key, property] of Object.entries(properties)) {
    const codex = property._meta?.codex;
    if (
      codex?.role === "user_note" &&
      typeof codex.questionId === "string" &&
      isText(property)
    ) {
      notes.set(codex.questionId, key);
    }
  }
  const customs = new Set<string>();
  const fields: Field[] = [];
  for (const [key, property] of Object.entries(properties)) {
    const note = notes.get(key);
    const custom = note ?? `${key}_custom`;
    const folds =
      choicesOf(property) !== undefined && isText(properties[custom]);
    if (folds) {
      customs.add(custom);
    }
    fields.push({
      key,
      property,
      ...(folds && { custom }),
      ...(folds && note && { codexNote: true }),
    });
  }
  return fields.filter(field => !customs.has(field.key));
}

function questionOf(field: Field, required: boolean): ChatInputQuestion {
  const { key, property } = field;
  const base = {
    id: key,
    ...(property.title && { title: property.title }),
    message: property.description || property.title || key,
    ...(required && { required }),
  };
  const choices = choicesOf(property)?.filter(
    choice => !(field.codexNote && isCodexNotePointer(choice)),
  );
  // A list without choices is asked as text; see `fromText`.
  if (property.type === "array" && choices) {
    return {
      ...base,
      kind: ChatInputQuestionKind.MultiSelect,
      options: choices,
      ...(field.custom && { allowFreeformInput: true }),
      ...(typeof property.minItems === "number" && { min: property.minItems }),
      ...(typeof property.maxItems === "number" && { max: property.maxItems }),
    };
  }
  if (choices) {
    return {
      ...base,
      kind: ChatInputQuestionKind.SingleSelect,
      options: choices.map(choice =>
        choice.id === property.default
          ? { ...choice, recommended: true }
          : choice,
      ),
      ...(field.custom && { allowFreeformInput: true }),
    };
  }
  if (property.type === "number" || property.type === "integer") {
    return {
      ...base,
      kind:
        property.type === "integer"
          ? ChatInputQuestionKind.Integer
          : ChatInputQuestionKind.Number,
      ...(typeof property.minimum === "number" && { min: property.minimum }),
      ...(typeof property.maximum === "number" && { max: property.maximum }),
      ...(typeof property.default === "number" && {
        defaultValue: property.default,
      }),
    };
  }
  if (property.type === "boolean") {
    return {
      ...base,
      kind: ChatInputQuestionKind.Boolean,
      ...(typeof property.default === "boolean" && {
        defaultValue: property.default,
      }),
    };
  }
  // Strings, and kinds ACP may add later: answered as text.
  return {
    ...base,
    kind: ChatInputQuestionKind.Text,
    ...(property.format && { format: property.format }),
    ...(typeof property.minLength === "number" && { min: property.minLength }),
    ...(typeof property.maxLength === "number" && { max: property.maxLength }),
    ...(typeof property.default === "string" && {
      defaultValue: property.default,
    }),
  };
}

/** Whether the agent goes on while the form is open: Codex asks such
 *  questions, and drops their answers once its turn ends. */
export const isAsyncForm = (request: { _meta?: unknown }): boolean =>
  (request._meta as { codex?: { delivery?: unknown } } | null | undefined)
    ?.codex?.delivery === "async";

export function inputRequestOf(
  id: string,
  message: string,
  schema: ElicitationSchema,
): ChatInputRequest {
  const required = new Set(schema.required ?? []);
  return {
    id,
    message,
    questions: fieldsOf(schema).map(field =>
      questionOf(field, required.has(field.key)),
    ),
  };
}

/** A text answer as the property's own kind: Chat sends typed numbers and
 *  free text as text. */
function fromText(property: Property, text: string): ElicitationContentValue {
  if (property.type === "number" || property.type === "integer") {
    const value = Number(text);
    return text.trim() && Number.isFinite(value) ? value : text;
  }
  if (property.type === "array") {
    return [text];
  }
  return property.type === "boolean" ? text === "true" : text;
}

/** The ACP response to Chat's answers to a request made by `inputRequestOf`. */
export function elicitationResponseOf(
  schema: ElicitationSchema,
  response: ChatInputResponseKind,
  answers: Record<string, ChatInputAnswer> = {},
): CreateElicitationResponse {
  if (response !== ChatInputResponseKind.Accept) {
    return {
      action: response === ChatInputResponseKind.Decline ? "decline" : "cancel",
    };
  }
  const content: Record<string, ElicitationContentValue> = {};
  for (const { key, property, custom } of fieldsOf(schema)) {
    const answer = answers[key];
    if (!answer || answer.state === ChatInputAnswerState.Skipped) {
      continue;
    }
    const { value } = answer;
    const typed =
      value.kind === ChatInputAnswerValueKind.Text
        ? [value.value]
        : value.kind === ChatInputAnswerValueKind.Selected ||
            value.kind === ChatInputAnswerValueKind.SelectedMany
          ? (value.freeformValues ?? [])
          : [];
    if (value.kind === ChatInputAnswerValueKind.Selected) {
      content[key] = property.type === "array" ? [value.value] : value.value;
    } else if (value.kind === ChatInputAnswerValueKind.SelectedMany) {
      content[key] = value.value;
    } else if (value.kind !== ChatInputAnswerValueKind.Text) {
      content[key] = value.value;
    } else if (!custom) {
      content[key] = fromText(property, value.value);
    }
    if (custom && typed.length) {
      content[custom] = typed.join("\n");
    }
  }
  return { action: "accept", content };
}
