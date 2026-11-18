// Codex, through codex-acp.
import { execFile } from "node:child_process";
import * as os from "node:os";
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

/** The model families to title with, smallest first. */
const TITLE_FAMILIES = [/-luna$/, /-terra$/];

/** Which models to try for a title, given the session's: each family's
 *  newest, then Codex's default (`undefined`). */
export const titleModels = (models: string[]): (string | undefined)[] => [
  ...TITLE_FAMILIES.flatMap(family =>
    models
      .filter(model => family.test(model))
      // ponytail: newest by slug order (gpt-6.1 > gpt-6 > gpt-5.6), a
      // model list field if Codex ever gives one.
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .slice(0, 1),
  ),
  undefined,
];

/** codex-acp titles a session itself, with a model a ChatGPT account can't
 *  use ("The 'gpt-5.6-luna' model is not supported"), and then keeps the
 *  first prompt as the title; this asks the same of a model the account
 *  has. */
const titlePrompt = (prompt: string) =>
  `Generate a very short title for a conversation that starts with the message below: 3-7 words, sentence case, no quotes, no trailing punctuation. Reply with the title only.

${prompt.slice(0, 4000)}`;

/** A reply's first line without the Markdown, quotes and punctuation a
 *  model may wrap a title in, cut to what a title list shows. */
export const titleOfReply = (reply: string): string =>
  (reply.trim().split("\n")[0] ?? "")
    .replace(/^[\s#*"'`]+|[\s*"'`.]+$/g, "")
    .slice(0, 80);

const bridge = {
  packageName: "@agentclientprotocol/codex-acp",
  binName: "codex-acp",
  cli: "codex",
  cliEnv: "CODEX_PATH",
  cliDirs: [],
};

/** A title from one model, by `codex exec`: ephemeral, so no thread is kept
 *  for it, and with the prompt on stdin, off the command line. */
const titleFrom = (
  env: NodeJS.ProcessEnv,
  model: string | undefined,
  prompt: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      env[bridge.cliEnv] ?? bridge.cli,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--config",
        "model_reasoning_effort=low",
        ...(model ? ["--model", model] : []),
        "-",
      ],
      { env, cwd: os.tmpdir(), timeout: 60_000 },
      (err, stdout, stderr) => {
        const title = titleOfReply(stdout);
        if (err || !title) {
          const said = stderr.trim().split("\n").at(-1);
          reject(
            new Error(
              `${model ?? "default model"}: ${said || err?.message || "no title"}`,
            ),
          );
        } else {
          resolve(title);
        }
      },
    );
    child.stdin?.end(titlePrompt(prompt));
  });

export const codex: AgentKind = {
  label: "Codex",
  description: "Spawns @agentclientprotocol/codex-acp",
  bridge,
  permissionsKey: "codex.permissionsPreset",
  formOf,
  // Each model in turn; only the last one's failure is told.
  titleOf: (env, prompt, models) =>
    titleModels(models).reduce<Promise<string>>(
      (title, model) => title.catch(() => titleFrom(env, model, prompt)),
      Promise.reject(new Error("no model")),
    ),
};
