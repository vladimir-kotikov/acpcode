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
}

/** One per window, named after its extension host's pid. */
export interface WindowInfo {
  folders: string[];
}

export const hostFiles = (dir: string) => ({
  host: path.join(dir, "host.json"),
  config: path.join(dir, "config.json"),
  windows: path.join(dir, "windows"),
  log: path.join(dir, "host.log"),
});

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
