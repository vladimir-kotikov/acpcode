// An agent's form (ACP elicitation) in terms every agent shares. Each agent
// kind makes one from ACP's request (`AgentKind.formOf`), so a frontend
// asking it never needs to know which agent sent it.
import type { ElicitationSchema } from "@agentclientprotocol/sdk";

/** A requested schema's property, any of ACP's kinds. */
export interface Property {
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
  _meta?: Record<string, unknown> | null;
}

export interface Choice {
  const: string;
  title: string;
  description?: string | null;
}

export interface Question {
  /** The property's name, which its answer goes under. */
  key: string;
  property: Property;
  required: boolean;
  /** The text property that takes this select's typed answer. */
  freeText?: string;
  /** Whether the agent asked to keep the answer hidden. */
  secret?: boolean;
}

export interface Form {
  message: string;
  questions: Question[];
  /** Said when the agent's turn ends with the form unanswered: an agent that
   *  goes on while its form is open drops a later answer. */
  unansweredNotice?: string;
}

const choicesOf = (property: Property) =>
  property.type === "array"
    ? (property.items?.anyOf ?? property.items?.enum)
    : property.type === "string"
      ? (property.oneOf ?? property.enum)
      : undefined;

export const isSelect = (property: Property): boolean =>
  Array.isArray(choicesOf(property));

export const isText = (property: Property | undefined): boolean =>
  property?.type === "string" && !choicesOf(property)?.length;

/** One question per property of the request's schema. */
/** ACP's request for a form. */
export interface FormRequest {
  message: string;
  requestedSchema: ElicitationSchema;
  _meta?: Record<string, unknown> | null;
}

export function plainForm(request: FormRequest): Form {
  const { properties, required } = request.requestedSchema;
  return {
    message: request.message,
    questions: Object.entries(
      (properties ?? {}) as Record<string, Property>,
    ).map(([key, property]) => ({
      key,
      property,
      required: required?.includes(key) ?? false,
    })),
  };
}

/** `form` with each select asked together with the text question
 *  `freeTextOf` names for it, which then takes its typed answer. */
export function withFreeText(
  form: Form,
  freeTextOf: (select: Question) => string | undefined,
): Form {
  const byKey = new Map(form.questions.map(q => [q.key, q]));
  const folded = new Set<string>();
  const questions = form.questions.map(question => {
    const freeText = isSelect(question.property)
      ? freeTextOf(question)
      : undefined;
    if (!freeText || !isText(byKey.get(freeText)?.property)) {
      return question;
    }
    folded.add(freeText);
    return { ...question, freeText };
  });
  return {
    ...form,
    questions: questions.filter(question => !folded.has(question.key)),
  };
}
