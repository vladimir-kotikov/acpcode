// The `claude agents` view lists background jobs, not transcripts: one
// `<config dir>/jobs/<short id>/state.json` per job, naming the session it
// runs. ACP's `session/delete` only removes the transcript, so a job outlives
// it unless removed here.
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `claude` asks nothing here: one still running after this is stuck. */
const TIMEOUT_MS = 30_000;

/** A job's directory name. Nothing else reaches the CLI, where a name
 *  starting with `-` would read as an option. */
const JOB_ID = /^\w[\w-]*$/;

const isMissing = (err: unknown): boolean =>
  ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");

/** The short ids of the jobs running `sessionId`. */
async function findJobs(
  configDir: string,
  sessionId: string,
): Promise<string[]> {
  const jobs = path.join(configDir, "jobs");
  let ids: string[];
  try {
    ids = await fs.readdir(jobs);
  } catch (err) {
    if (isMissing(err)) {
      return [];
    }
    throw err;
  }
  const found: string[] = [];
  for (const id of ids.filter(id => JOB_ID.test(id))) {
    let state: { sessionId?: string };
    try {
      state = JSON.parse(
        await fs.readFile(path.join(jobs, id, "state.json"), "utf8"),
      ) as typeof state;
    } catch (err) {
      // Not a job (`pins.json`), or one being written.
      if (isMissing(err) || err instanceof SyntaxError) {
        continue;
      }
      throw err;
    }
    if (state.sessionId === sessionId) {
      found.push(id);
    }
  }
  return found;
}

/** Runs the CLI, answering what it printed; a failure carries that too
 *  (execFile's message has only stderr). */
async function claude(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(
      env.CLAUDE_CODE_EXECUTABLE ?? "claude",
      args,
      { env, timeout: TIMEOUT_MS },
    );
    return (stdout + stderr).trim();
  } catch (err) {
    const { stdout = "" } = err as { stdout?: string };
    throw new Error(`${(err as Error).message}${stdout}`.trim(), {
      cause: err,
    });
  }
}

/** What ctrl+x in `claude agents` does: stops the session's jobs and deletes
 *  them, with their worktrees when that's safe. The transcript is left
 *  alone. `env` is the agent's (`agentProcessEnv`): its config dir and CLI.
 *  Answers what `rm` printed. */
export async function removeClaudeJob(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): Promise<string> {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const printed: string[] = [];
  for (const id of await findJobs(configDir, sessionId)) {
    await claude(env, ["stop", id]).catch((err: Error) => {
      // An exited job has nothing to stop: only a CLI that ran and said no
      // is fine.
      if (typeof (err.cause as { code?: unknown }).code !== "number") {
        throw err;
      }
    });
    printed.push(await claude(env, ["rm", id]));
  }
  return printed.filter(Boolean).join("\n");
}
