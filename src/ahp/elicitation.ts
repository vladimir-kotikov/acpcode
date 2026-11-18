// An agent's forms ⇄ AHP input requests. Both follow MCP's elicitation
// schema: each property of the requested schema is a question, keyed by the
// property's name.
import type {
  CreateElicitationResponse,
  ElicitationContentValue,
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
import type { Form, Property, Question } from "../acp/forms.ts";

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

/** Told with a question the agent marks secret: Chat can't mask an answer. */
export const SECRET_ANSWER_WARNING =
  "Your answer will show in the chat and its history.";

function questionOf(question: Question): ChatInputQuestion {
  const { key, property, required } = question;
  const message = property.description || property.title || key;
  const base = {
    id: key,
    ...(property.title && { title: property.title }),
    message: question.secret
      ? `${message}\n\n${SECRET_ANSWER_WARNING}`
      : message,
    ...(required && { required }),
  };
  const choices = choicesOf(property);
  // A list without choices is asked as text; see `fromText`.
  if (property.type === "array" && choices) {
    return {
      ...base,
      kind: ChatInputQuestionKind.MultiSelect,
      options: choices,
      ...(question.freeText && { allowFreeformInput: true }),
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
      ...(question.freeText && { allowFreeformInput: true }),
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

export const inputRequestOf = (id: string, form: Form): ChatInputRequest => ({
  id,
  message: form.message,
  questions: form.questions.map(questionOf),
});

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
  form: Form,
  response: ChatInputResponseKind,
  answers: Record<string, ChatInputAnswer> = {},
): CreateElicitationResponse {
  if (response !== ChatInputResponseKind.Accept) {
    return {
      action: response === ChatInputResponseKind.Decline ? "decline" : "cancel",
    };
  }
  const content: Record<string, ElicitationContentValue> = {};
  for (const { key, property, freeText } of form.questions) {
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
    } else if (!freeText) {
      content[key] = fromText(property, value.value);
    }
    if (freeText && typed.length) {
      content[freeText] = typed.join("\n");
    }
  }
  return { action: "accept", content };
}
