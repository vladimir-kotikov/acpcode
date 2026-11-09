// A stand-in `claude` CLI with its own config dir, for tests: it logs each
// call (and refuses `failOn`), and `job()` adds a `claude agents` job.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

export function fakeClaude(t: TestContext, failOn?: "stop" | "rm") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-jobs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "log");
  const cli = path.join(dir, "claude");
  fs.writeFileSync(
    cli,
    [
      "#!/bin/sh",
      `echo "$CLAUDE_CONFIG_DIR $*" >> "${log}"`,
      failOn ? `[ "$1" = ${failOn} ] && { echo refused; exit 1; }` : "",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    env: { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_EXECUTABLE: cli },
    /** Registers this process as a `claude` running `sessionId`, as a
     *  terminal or background one does; answers how to unregister it. */
    running(sessionId: string, kind: "bg" | "interactive" = "bg") {
      const file = path.join(dir, "sessions", `${process.pid}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          pid: process.pid,
          sessionId,
          kind,
          entrypoint: "cli",
        }),
      );
      return () => fs.rmSync(file);
    },
    /** Adds a job dir whose `state.json` is `state`. */
    job(id: string, state: string) {
      fs.mkdirSync(path.join(dir, "jobs", id), { recursive: true });
      fs.writeFileSync(path.join(dir, "jobs", id, "state.json"), state);
    },
    /** The calls so far, as `<args>` — or `<config dir> <args>` when the CLI
     *  didn't get the agent's config dir. */
    calls: (): string[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map(line => line.replace(`${dir} `, ""))
        : [],
  };
}

/** Polls `done` until it holds; for work spanning processes and fs calls. */
export async function waitFor(done: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
