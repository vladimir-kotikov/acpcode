// The state directory shared by the extension and the detached agent host
// (`hostMain.ts`). Plain JSON files, each with a single writer.
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../acp/agents/config.ts";

/** Written by the host once it owns the port. */
export interface HostInfo {
  pid: number;
  build: string;
  port: number;
}

/** Written by the extension (every window writes the same thing). */
export interface HostConfig {
  agents: AgentConfig[];
  /** List only the sessions of the open windows' folders, not every project's. */
  filterSessionsByWorkspace?: boolean;
}

/** One per window, named after its extension host's pid. */
export interface WindowInfo {
  folders: string[];
  /** When the window last gained focus (ms epoch); orders the host's folders. */
  focusedAt?: number;
}

export const hostFiles = (dir: string) => ({
  host: path.join(dir, "host.json"),
  config: path.join(dir, "config.json"),
  /** Written by the host: last-seen ACP config options per agent. */
  configOptions: path.join(dir, "configOptions.json"),
  /** Written by the host: whether each agent accepts image prompts. */
  imageSupport: path.join(dir, "imageSupport.json"),
  /** Written by the host: the extra directories of each session, which the
   *  agents' session lists don't report (`${agent}\0${sessionId}`). */
  directories: path.join(dir, "directories.json"),
  windows: path.join(dir, "windows"),
  log: path.join(dir, "host.log"),
});

/** Every window's folders, deduped, the most recently focused window's first:
 *  chat sends no directory for a new session, so the host's first folder is
 *  its cwd — and the window creating it is the focused one.
 *  ponytail: focus heuristic, wrong only if a chat is created from an
 *  unfocused window; needs a per-window connection to know for sure. */
export const windowFolders = (windows: WindowInfo[]): string[] => [
  ...new Set(
    windows
      .toSorted((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0))
      .flatMap(w => w.folders),
  ),
];

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
