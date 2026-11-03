import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vscode from "vscode";
import { AgentConnectionPool } from "./acp/agentPool.ts";
import { setBridgesDir } from "./acp/bridges.ts";
import { installBridges } from "./bridgeInstaller.ts";
import {
  addAgentCommand,
  editAgentsConfigCommand,
} from "./acp/agents/commands.ts";
import {
  hostFiles,
  isAlive,
  readJson,
  type HostConfig,
  type HostInfo,
  type WindowInfo,
} from "./ahp/hostFiles.ts";
import {
  SessionViewProvider,
  type SessionTarget,
} from "./sessionViewProvider.ts";
import { getAgents, toggleGroupSessionsByCwd } from "./settings.ts";
import { SessionsTreeProvider } from "./treeProvider.ts";

export function activate(context: vscode.ExtensionContext) {
  setBridgesDir(bridgesDir(context));
  const agentPool = new AgentConnectionPool(name =>
    vscode.window.createOutputChannel(name),
  );
  const sessionViewProvider = new SessionViewProvider(
    context.extensionUri,
    agentPool,
  );
  const treeProvider = new SessionsTreeProvider(agentPool, sessionViewProvider);
  // The tree's session lists fetched while a bridge was missing show an error
  // until refreshed. (The agent host notices installs itself.)
  const installAndRefresh = (update: boolean) =>
    installBridges(update).then(changed => changed && treeProvider.refresh());

  context.subscriptions.push(
    agentPool,
    treeProvider,
    sessionViewProvider,
    vscode.window.registerTreeDataProvider("acpcode.sessions", treeProvider),
    vscode.window.registerWebviewViewProvider(
      "acpcode.sessionView",
      sessionViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewPanelSerializer(
      "acpcode.sessionViewEditor",
      sessionViewProvider,
    ),
    vscode.commands.registerCommand("acpcode.addAgent", addAgentCommand),
    vscode.commands.registerCommand(
      "acpcode.editAgentsConfig",
      editAgentsConfigCommand,
    ),
    vscode.commands.registerCommand(
      "acpcode.refreshSessions",
      treeProvider.refresh,
    ),
    vscode.commands.registerCommand(
      "acpcode.toggleGroupSessionsByCwd",
      toggleGroupSessionsByCwd,
    ),
    vscode.commands.registerCommand(
      "acpcode.openSession",
      (target: SessionTarget) => sessionViewProvider.openSession(target),
    ),
    vscode.commands.registerCommand(
      "acpcode.openSessionInEditor",
      sessionViewProvider.openInEditor,
    ),
    // Invoked from a session tree item's context menu / inline button, which
    // VS Code calls with the raw tree node (not a vscode.TreeItem) as the arg.
    vscode.commands.registerCommand(
      "acpcode.openTreeSessionInEditor",
      (node: {
        agent: { name: string };
        session: { sessionId: string; cwd: string; title?: string | null };
      }) =>
        sessionViewProvider.openInEditor({
          agentName: node.agent.name,
          sessionId: node.session.sessionId,
          cwd: node.session.cwd,
          title: node.session.title,
        }),
    ),
    vscode.commands.registerCommand(
      "acpcode.deleteSession",
      treeProvider.deleteSession,
    ),
    vscode.commands.registerCommand(
      "acpcode.newSession",
      treeProvider.newSession,
    ),
    // Explorer/tab context-menu command — VS Code calls a resource-scoped
    // command with (clickedResource, allSelectedResources), the latter only
    // populated on a multi-select.
    vscode.commands.registerCommand(
      "acpcode.attachFileToChat",
      (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const targets = selected?.length ? selected : clicked ? [clicked] : [];
        void sessionViewProvider.attachFilesToChat(targets);
      },
    ),
    vscode.commands.registerCommand("acpcode.connectChatToAgentHost", () =>
      connectChatToAgentHost(context),
    ),
    vscode.commands.registerCommand("acpcode.restartAgentHost", () =>
      restartAgentHost(context).then(() =>
        vscode.window.showInformationMessage("ACP Code agent host restarted."),
      ),
    ),
    vscode.commands.registerCommand("acpcode.updateBridges", () =>
      installAndRefresh(true),
    ),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration("acpcode.agents") ||
        event.affectsConfiguration("acpcode.bridgeVersions")
      ) {
        void installAndRefresh(false);
      }
    }),
    vscode.commands.registerCommand("acpcode.showAgentHostLog", () =>
      vscode.window.showTextDocument(
        vscode.Uri.file(hostFiles(agentHostDir(context)).log),
      ),
    ),
  );

  void installAndRefresh(false);
  startAgentHost(context);
}

const AGENT_HOST_NAME = "ACP Code";

/** Stable across restarts so the workspace setting written by
 *  `connectChatToAgentHost` keeps working. */
function agentHostToken(context: vscode.ExtensionContext): string {
  const key = "agentHost.connectionToken";
  let token = context.globalState.get<string>(key);
  if (!token) {
    token = randomBytes(24).toString("base64url");
    void context.globalState.update(key, token);
  }
  return token;
}

/** State shared with the detached host (`ahp/hostMain.ts`). Global storage,
 *  so every window talks to the same host. */
const agentHostDir = (context: vscode.ExtensionContext): string =>
  path.join(context.globalStorageUri.fsPath, "agentHost");

/** Shared with the detached host, which spawns bridges too (but never installs them). */
const bridgesDir = (context: vscode.ExtensionContext): string =>
  path.join(context.globalStorageUri.fsPath, "bridges");

const agentHostPort = (): number =>
  vscode.workspace
    .getConfiguration("acpcode.agentHost")
    .get<number>("port", 8765);

/** Changes with every install, so a reinstall or update restarts the host:
 *  the version alone doesn't change on dev reinstalls. */
function agentHostBuild(context: vscode.ExtensionContext): string {
  const installed = fs.statSync(
    path.join(context.extensionPath, "package.json"),
  ).mtimeMs;
  return `${context.extension.packageJSON.version}+${installed}`;
}

/** Tells the host about this window, and starts it unless one from this
 *  build is already running (e.g. it outlived a window reload). */
function startAgentHost(context: vscode.ExtensionContext): void {
  if (
    !vscode.workspace
      .getConfiguration("acpcode.agentHost")
      .get<boolean>("enabled", false)
  ) {
    return;
  }
  const files = hostFiles(agentHostDir(context));
  fs.mkdirSync(files.windows, { recursive: true });
  const writeConfig = () => {
    const config: HostConfig = { agents: getAgents() };
    fs.writeFileSync(files.config, JSON.stringify(config));
  };
  const windowFile = path.join(files.windows, `${process.pid}.json`);
  const writeWindow = () => {
    const info: WindowInfo = {
      folders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
    };
    fs.writeFileSync(windowFile, JSON.stringify(info));
  };
  writeConfig();
  writeWindow();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("acpcode.agents")) {
        writeConfig();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(writeWindow),
    { dispose: () => fs.rmSync(windowFile, { force: true }) },
  );

  const running = readJson<HostInfo>(files.host);
  if (
    running &&
    isAlive(running.pid) &&
    running.build === agentHostBuild(context) &&
    running.port === agentHostPort()
  ) {
    return;
  }
  // ponytail: an update restarts the host even mid-turn; wait for it to go
  // idle first if that bites.
  void restartAgentHost(context);
}

function restartAgentHost(context: vscode.ExtensionContext): Promise<void> {
  const files = hostFiles(agentHostDir(context));
  return stopProcess(readJson<HostInfo>(files.host)?.pid).then(() =>
    spawnAgentHost(context, files),
  );
}

/** SIGTERM, then SIGKILL if it's still around after 5 s. */
function stopProcess(pid: number | undefined): Promise<void> {
  if (!pid || !isAlive(pid)) {
    return Promise.resolve();
  }
  process.kill(pid, "SIGTERM");
  const started = Date.now();
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (isAlive(pid) && Date.now() - started < 5000) {
        return;
      }
      clearInterval(timer);
      if (isAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
      resolve();
    }, 100);
  });
}

function spawnAgentHost(
  context: vscode.ExtensionContext,
  files: ReturnType<typeof hostFiles>,
): void {
  // Appended to rather than truncated: windows starting together each spawn
  // a host, and the losers' "port in use" line lands next to the winner's log.
  if (fs.existsSync(files.log) && fs.statSync(files.log).size > 1_000_000) {
    fs.renameSync(files.log, `${files.log}.old`);
  }
  const log = fs.openSync(files.log, "a");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./ahp/hostMain.ts", import.meta.url))],
    {
      cwd: agentHostDir(context),
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ACPCODE_HOST_DIR: agentHostDir(context),
        ACPCODE_HOST_PORT: String(agentHostPort()),
        ACPCODE_HOST_TOKEN: agentHostToken(context),
        ACPCODE_HOST_BUILD: agentHostBuild(context),
        ACPCODE_BRIDGES_DIR: bridgesDir(context),
      },
    },
  );
  fs.closeSync(log);
  child.unref();
  child.once("exit", code => {
    // Losing the startup race to another window's host is fine.
    const running = readJson<HostInfo>(files.host);
    if (code && !(running && isAlive(running.pid))) {
      void vscode.window
        .showWarningMessage(
          `ACP Code agent host exited (code ${code}).`,
          "Show Log",
        )
        .then(choice => {
          if (choice) {
            void vscode.commands.executeCommand("acpcode.showAgentHostLog");
          }
        });
    }
  });
}

async function connectChatToAgentHost(
  context: vscode.ExtensionContext,
): Promise<void> {
  const entry = {
    name: AGENT_HOST_NAME,
    address: `127.0.0.1:${agentHostPort()}`,
    connectionToken: agentHostToken(context),
  };
  const chat = vscode.workspace.getConfiguration("chat");
  // Despite its name this setting is resource-scoped, so a user-level value
  // reaches every editor window (`chat.remoteAgentHosts` is only read by the
  // Agents window).
  const hosts =
    chat.inspect<{ name: string }[]>("workspaceRemoteAgentHosts")
      ?.globalValue ?? [];
  try {
    await chat.update(
      "workspaceRemoteAgentHosts",
      [...hosts.filter(h => h.name !== AGENT_HOST_NAME), entry],
      vscode.ConfigurationTarget.Global,
    );
    await chat.update(
      "remoteAgentHostsEnabled",
      true,
      vscode.ConfigurationTarget.Global,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Couldn't update Chat settings (needs VS Code 1.145+): ${String(err)}`,
    );
    return;
  }
  const hostConfig = vscode.workspace.getConfiguration("acpcode.agentHost");
  if (!hostConfig.get<boolean>("enabled", false)) {
    await hostConfig.update("enabled", true, vscode.ConfigurationTarget.Global);
    const reload = await vscode.window.showInformationMessage(
      "ACP Code agent host enabled. Reload the window to start it.",
      "Reload Window",
    );
    if (reload) {
      void vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}

export function deactivate() {}
