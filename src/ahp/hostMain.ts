// Entry point of the detached agent host: the AHP server plus its agent
// bridges, in a process of its own so it survives window reloads. Spawned by
// the extension (see `startAgentHost` in extension.ts) with
// ELECTRON_RUN_AS_NODE; stdout/stderr go to `host.log`.
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentConnectionPool } from "../acp/agentPool.ts";
import type { AgentConfig } from "../acp/agents/config.ts";
import type { Output } from "../shared/events.ts";
import { AcpAgentHost } from "./acpBridge.ts";
import {
  hostFiles,
  isAlive,
  readJson,
  type HostConfig,
  type HostInfo,
  type WindowInfo,
} from "./hostFiles.ts";

const IDLE_EXIT_MS = 10 * 60_000;

// Passed via env rather than argv so the token doesn't show up in `ps`.
const {
  ACPCODE_HOST_DIR: dir,
  ACPCODE_HOST_PORT: port,
  ACPCODE_HOST_TOKEN: token,
  ACPCODE_HOST_BUILD: build,
} = process.env;
if (!dir || !port || !token || !build) {
  console.error("ACPCODE_HOST_{DIR,PORT,TOKEN,BUILD} must be set");
  process.exit(2);
}
// The agent bridges inherit process.env; keep the token out of it.
delete process.env.ACPCODE_HOST_TOKEN;

const files = hostFiles(dir);

const output = (prefix: string): Output => ({
  append: text => process.stderr.write(text),
  appendLine: text =>
    process.stderr.write(`${new Date().toISOString()} ${prefix}${text}\n`),
  dispose: () => {},
});
const log = output("");

// The extension host would swallow these; don't let one bad callback take
// every running turn down with it.
process.on("uncaughtException", err =>
  log.appendLine(`[uncaught] ${err.stack}`),
);
process.on("unhandledRejection", err =>
  log.appendLine(`[unhandled rejection] ${String(err)}`),
);

let agentsJson = "";
let agents: AgentConfig[] = [];
const loadAgents = (): boolean => {
  const next = JSON.stringify(readJson<HostConfig>(files.config)?.agents ?? []);
  const changed = next !== agentsJson;
  agentsJson = next;
  agents = JSON.parse(next) as AgentConfig[];
  return changed;
};
loadAgents();

/** Union of every live window's workspace folders; prunes dead windows. */
const folders = (): string[] => {
  const result = new Set<string>();
  for (const name of fs.readdirSync(files.windows)) {
    const file = path.join(files.windows, name);
    if (!isAlive(Number.parseInt(name, 10))) {
      fs.rmSync(file, { force: true });
      continue;
    }
    for (const folder of readJson<WindowInfo>(file)?.folders ?? []) {
      result.add(folder);
    }
  }
  return [...result];
};

const pool = new AgentConnectionPool(name => output(`[${name}] `));
const host = new AcpAgentHost(pool, log, {
  agents: () => agents,
  folders,
  configCache: {
    load: () => readJson(files.configOptions) ?? {},
    save: cache => fs.writeFileSync(files.configOptions, JSON.stringify(cache)),
  },
  imageCache: {
    load: () => readJson(files.imageSupport) ?? {},
    save: cache => fs.writeFileSync(files.imageSupport, JSON.stringify(cache)),
  },
});

fs.mkdirSync(files.windows, { recursive: true });
// ponytail: fs.watch fires several times per write on macOS; loadAgents
// dedupes. Watching the directory survives the file being replaced.
fs.watch(dir, (_, name) => {
  if (name === "config.json" && loadAgents()) {
    log.appendLine("agents changed");
    host.agentsChanged();
  }
});

const shutdown = (reason: string): void => {
  log.appendLine(`exiting: ${reason}`);
  host.dispose();
  pool.dispose();
  if (readJson<HostInfo>(files.host)?.pid === process.pid) {
    fs.rmSync(files.host, { force: true });
  }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Binding the port is the single-instance lock: a second host exits here.
host.server.listen(Number(port), token).then(
  () => {
    const info: HostInfo = { pid: process.pid, build, port: Number(port) };
    fs.writeFileSync(files.host, JSON.stringify(info));
    log.appendLine(`listening on 127.0.0.1:${port} (build ${build})`);

    let idleSince = Date.now();
    setInterval(() => {
      if (host.server.connectionCount > 0 || host.busy) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince > IDLE_EXIT_MS) {
        shutdown("idle");
      }
    }, 30_000);
  },
  (err: unknown) => {
    log.appendLine(`couldn't listen on 127.0.0.1:${port}: ${String(err)}`);
    process.exit(1);
  },
);
