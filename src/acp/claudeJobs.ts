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

const isAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** What runs `sessionId` besides an SDK, so not a bridge's own `claude`: one
 *  in a terminal, or a background job. Every running `claude` registers in
 *  `<config dir>/sessions/<pid>.json`. `env` is the agent's.
 *  ponytail: a pid reused by an unrelated process reads as the owner; the
 *  entry's `procStart` would tell them apart. */
export async function sessionOwner(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): Promise<string | undefined> {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const registry = path.join(configDir, "sessions");
  let files: string[];
  try {
    files = await fs.readdir(registry);
  } catch (err) {
    if (isMissing(err)) {
      return undefined;
    }
    throw err;
  }
  for (const file of files.filter(f => f.endsWith(".json"))) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(await fs.readFile(path.join(registry, file), "utf8"));
    } catch {
      continue; // gone, or being rewritten
    }
    if (
      entry.sessionId === sessionId &&
      entry.entrypoint === "cli" &&
      isAlive(entry.pid)
    ) {
      return entry.kind === "bg"
        ? `background job ${sessionId.slice(0, 8)}`
        : "a terminal";
    }
  }
  return undefined;
}
