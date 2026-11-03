// Where the agents' executables come from. Neither ships with the extension:
// each ACP bridge is npm-installed into global storage by the extension host
// (see `bridgeInstaller.ts`), and the agent CLI it drives (`claude`, `codex`)
// is the user's own install.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentConfig } from "./agents/config.ts";

type Kind = AgentConfig["kind"];

/** Per agent kind: the bridge's npm package and which key in its `bin` map to
 *  spawn, plus the agent CLI the bridge drives — found on the user's machine
 *  and handed over in `cliEnv`, which both bridges check before falling back
 *  to their bundled copy (claude-agent-acp: `CLAUDE_CODE_EXECUTABLE`,
 *  codex-acp: `CODEX_PATH`). */
const AGENTS: Record<
  Kind,
  {
    packageName: string;
    binName: string;
    cli: string;
    cliEnv: string;
    cliDirs: string[];
  }
> = {
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    binName: "claude-agent-acp",
    cli: "claude",
    cliEnv: "CLAUDE_CODE_EXECUTABLE",
    // Where `claude migrate-installer` puts it.
    cliDirs: [path.join(os.homedir(), ".claude", "local")],
  },
  codex: {
    packageName: "@agentclientprotocol/codex-acp",
    binName: "codex-acp",
    cli: "codex",
    cliEnv: "CODEX_PATH",
    cliDirs: [],
  },
};

/** `env` with `file`'s directory first on PATH. npm, and CLIs installed with
 *  it, are `#!/usr/bin/env node` scripts, while a GUI-launched VS Code's PATH
 *  can lack the `node` that sits right next to them (Homebrew, nvm, mise, the
 *  official installer): found through `COMMON_DIRS`, they'd fail with "env:
 *  node: No such file or directory". */
function withDirOnPath(
  env: NodeJS.ProcessEnv,
  file: string,
): NodeJS.ProcessEnv {
  // Windows spells it "Path"; a second, differently cased key would clash.
  const key = Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...env,
    [key]: [path.dirname(file), env[key]].filter(Boolean).join(path.delimiter),
  };
}

/** Searched after PATH: a GUI-launched VS Code's PATH can miss them. */
const COMMON_DIRS = [
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

const pathDirs = () => (process.env.PATH ?? "").split(path.delimiter);

function findExecutable(name: string, dirs: string[]): string | undefined {
  const names =
    process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs.filter(Boolean)) {
    for (const exe of names) {
      const candidate = path.join(dir, exe);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here — keep looking
      }
    }
  }
  return undefined;
}

/** `env` with the kind's agent CLI set for its bridge, unless `env` already
 *  points at one. The user's CLI follows its own updates, while a bundled one
 *  lags (new models refuse old versions outright: "Claude Code 2.1.232 does
 *  not support this model"); the bundled copies aren't even installed (see
 *  `install`), so a missing CLI is an error, not a fallback. */
export function withAgentCli(
  kind: Kind,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const { cli, cliEnv, cliDirs } = AGENTS[kind];
  const dirs = [...cliDirs, ...COMMON_DIRS];
  const found = env[cliEnv] ?? findExecutable(cli, [...pathDirs(), ...dirs]);
  if (!found) {
    throw new Error(
      `${cli} not found on PATH or in ${dirs.join(", ")}. Install it, or set ${cliEnv} in the agent's env.`,
    );
  }
  return withDirOnPath({ ...env, [cliEnv]: found }, found);
}

let bridgesDir: string | undefined;

/** Global storage, shared by every window and the detached agent host. Set
 *  once at startup by each process that spawns bridges. */
export function setBridgesDir(dir: string): void {
  bridgesDir = dir;
}

function kindDir(kind: Kind): string {
  if (!bridgesDir) {
    throw new Error("setBridgesDir() must be called before connecting");
  }
  return path.join(bridgesDir, kind);
}

export const bridgePackage = (kind: Kind): string => AGENTS[kind].packageName;

/** `<kindDir>/current.json`: the install connections use, and the npm version
 *  spec it was installed for (so a changed pin is noticed without asking the
 *  registry). */
export type InstalledBridge = { version: string; spec: string };

export function installedBridge(kind: Kind): InstalledBridge | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(kindDir(kind), "current.json"), "utf8"),
    ) as InstalledBridge;
  } catch {
    return undefined;
  }
}

/** Atomic, so another process never reads half a file. */
function writeCurrent(kind: Kind, current: InstalledBridge): void {
  const file = path.join(kindDir(kind), "current.json");
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(current));
  fs.renameSync(tmp, file);
}

/** Bin entry point of an installed bridge version. Read from its package.json
 *  rather than through Node's resolver, which would depend on the package's
 *  "exports" map shape. */
function entryPoint(kind: Kind, version: string): string {
  const { packageName, binName } = AGENTS[kind];
  const pkgDir = path.join(kindDir(kind), version, "node_modules", packageName);
  const binRel = (
    JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    }
  ).bin?.[binName];
  if (!binRel) {
    throw new Error(
      `${packageName} package does not declare a "${binName}" bin entry`,
    );
  }
  return path.join(pkgDir, binRel);
}

const installs = new Map<Kind, Promise<InstallResult>>();

/** Entry point of the kind's installed bridge. Never installs: only the
 *  extension host does (`installBridge`, with UI), so a connect there waits
 *  for an install it has in flight; the detached host just reads what's on
 *  disk. */
export async function bridgeEntryPoint(kind: Kind): Promise<string> {
  const installError = await installs.get(kind)?.then(
    () => undefined,
    (err: unknown) => err,
  );
  const current = installedBridge(kind);
  if (!current) {
    // Why it isn't installed beats a generic "isn't installed".
    throw (
      installError ??
      new Error(
        `${bridgePackage(kind)} isn't installed. Run "ACP Code: Update Agent Bridges" in VS Code.`,
      )
    );
  }
  return entryPoint(kind, current.version);
}

/** Checks that an installed bridge works with this client (spawns it and
 *  completes `initialize`, protocol version included); throws if not. */
export type BridgeProbe = (entryPoint: string) => Promise<void>;

export type InstallResult = {
  version: string;
  /** False when `spec` already resolved to the installed version. */
  changed: boolean;
  previous?: string;
};

/** Installs the bridge version `spec` (an npm version, range or dist-tag)
 *  resolves to, and switches to it if `probe` passes; otherwise the last good
 *  install stays in use. Installs of a kind run one after another in this
 *  process, so the last call's spec is what ends up installed. */
export function installBridge(
  kind: Kind,
  spec: string,
  probe: BridgeProbe,
  report: (step: string) => void,
): Promise<InstallResult> {
  const pending = (installs.get(kind) ?? Promise.resolve())
    .catch(() => {})
    .then(() => install(kind, spec, probe, report));
  installs.set(kind, pending);
  return pending;
}

/** Other processes (windows) may install concurrently: each builds in a temp
 *  dir and renames it into place, so a version dir is always complete. */
async function install(
  kind: Kind,
  spec: string,
  probe: BridgeProbe,
  report: (step: string) => void,
): Promise<InstallResult> {
  const { packageName } = AGENTS[kind];
  const dir = kindDir(kind);
  const current = installedBridge(kind);

  report(`Resolving ${packageName}@${spec}`);
  // A range matching several versions lists them all, oldest first.
  const resolved = JSON.parse(
    await npm(["view", `${packageName}@${spec}`, "version", "--json"]),
  ) as string | string[] | undefined;
  // No match at all is npm's own E404.
  const version = Array.isArray(resolved) ? resolved.at(-1)! : resolved!;
  if (version === current?.version) {
    writeCurrent(kind, { ...current, spec });
    return { version, changed: false };
  }

  const target = path.join(dir, version);
  if (!fs.existsSync(target)) {
    report(`Installing ${packageName}@${version}`);
    fs.mkdirSync(dir, { recursive: true });
    // ponytail: a crash mid-install leaks its .tmp- dir; sweep stale ones if
    // that ever shows up.
    const tmp = fs.mkdtempSync(path.join(dir, ".tmp-"));
    try {
      // Optional dependencies are the bridges' bundled agent binaries
      // (hundreds of MB per platform), unused next to the user's own CLI.
      await npm([
        "install",
        "--prefix",
        tmp,
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        `${packageName}@${version}`,
      ]);
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      // Another process got there first: its install is just as good.
      if (!fs.existsSync(target)) {
        throw err;
      }
    }
  }

  report(`Verifying ${packageName}@${version}`);
  try {
    await probe(entryPoint(kind, version));
  } catch (err) {
    const keeping = current ? ` Still using ${current.version}.` : "";
    throw new Error(
      `${packageName}@${version} doesn't work with ACP Code: ${err instanceof Error ? err.message : String(err)}.${keeping}`,
    );
  }

  // ponytail: replaced versions stay on disk (connections may still run
  // them); prune all but current if disk use ever matters.
  writeCurrent(kind, { version, spec });
  return { version, changed: true, previous: current?.version };
}

const execFileAsync = promisify(execFile);

async function npm(args: string[]): Promise<string> {
  const npmPath = findExecutable("npm", [...pathDirs(), ...COMMON_DIRS]);
  if (!npmPath) {
    throw new Error(
      `npm not found on PATH or in ${COMMON_DIRS.join(", ")}: ACP Code installs agent bridges with npm. Install Node.js, which includes it.`,
    );
  }
  // npm runs on the `node` it finds on PATH, its own directory first (see
  // `withDirOnPath`); without one it dies with a cryptic "env: node: No such
  // file or directory".
  if (!findExecutable("node", [path.dirname(npmPath), ...pathDirs()])) {
    throw new Error(
      `node not found next to ${npmPath} or on PATH: npm needs it to install agent bridges. Install Node.js, or add its directory to PATH.`,
    );
  }
  // npm.cmd only runs through a shell on Windows, which would split paths
  // with spaces unless quoted.
  const win = process.platform === "win32";
  try {
    const { stdout } = await execFileAsync(
      win ? `"${npmPath}"` : npmPath,
      win ? args.map(arg => `"${arg}"`) : args,
      {
        shell: win,
        env: withDirOnPath(process.env, npmPath),
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (err) {
    // The error's message repeats the command line and npm's whole stderr;
    // its first "npm error" lines (code, summary) are what a notification
    // needs.
    const detail = ((err as { stderr?: string }).stderr ?? "")
      .split("\n")
      .filter(line => line.startsWith("npm error "))
      .map(line => line.slice("npm error ".length).trim())
      .filter(line => line && !line.startsWith("A complete log"))
      .slice(0, 2)
      .join(" — ");
    throw new Error(
      `npm ${args[0]} failed: ${detail || (err as Error).message}`,
    );
  }
}
