// Codex, through codex-acp.
import {
  plainForm,
  withFreeText,
  type Form,
  type FormRequest,
  type Property,
  type Question,
} from "../forms.ts";
import type { AgentKind } from "./kinds.ts";

/** Said when Codex's turn ends with its question unanswered. */
export const UNANSWERED_QUESTION_NOTICE =
  "Codex went ahead without your answer. Reply in a new message if it still matters.";

type CodexMeta = {
  role?: unknown;
  questionId?: unknown;
  isSecret?: unknown;
  delivery?: unknown;
};

const codexMeta = (meta: Record<string, unknown> | null | undefined) =>
  meta?.codex as CodexMeta | undefined;

/** The choice codex-acp adds to a select that has a note box, unless one of
 *  the select's own is called so. */
const isNotePointer = (choice: { const: string; description?: unknown }) =>
  choice.const === "None of the above" &&
  choice.description === "Provide a different answer in the note field.";

/** A select asked with its note box: the question takes typed text, so the
 *  choice pointing at the box goes. */
const withoutNotePointer = (question: Question): Question => {
  const { oneOf } = question.property;
  return question.freeText && oneOf
    ? {
        ...question,
        property: {
          ...question.property,
          oneOf: oneOf.filter(choice => !isNotePointer(choice)),
        } satisfies Property,
      }
    : question;
};

/** Codex follows a select that takes another answer with a note box, which
 *  names the select in `_meta`. Codex can ask without stopping: it then drops
 *  an answer that comes after its turn ends. */
function formOf(request: FormRequest): Form {
  const form = plainForm(request);
  const notes = new Map(
    form.questions.flatMap(({ key, property }) => {
      const codex = codexMeta(property._meta);
      return codex?.role === "user_note" && typeof codex.questionId === "string"
        ? [[codex.questionId, key] as const]
        : [];
    }),
  );
  const asked = withFreeText(form, select => notes.get(select.key));
  return {
    ...asked,
    questions: asked.questions.map(question => ({
      ...withoutNotePointer(question),
      ...(codexMeta(question.property._meta)?.isSecret === true && {
        secret: true,
      }),
    })),
    ...(codexMeta(request._meta)?.delivery === "async" && {
      unansweredNotice: UNANSWERED_QUESTION_NOTICE,
    }),
  };
}

export const codex: AgentKind = {
  label: "Codex",
  description: "Spawns @agentclientprotocol/codex-acp",
  bridge: {
    packageName: "@agentclientprotocol/codex-acp",
    binName: "codex-acp",
    cli: "codex",
    cliEnv: "CODEX_PATH",
    cliDirs: [],
  },
  permissionsKey: "codex.permissionsPreset",
  formOf,
};
