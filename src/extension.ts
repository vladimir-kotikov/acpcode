import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { AgentConnectionPool } from "./acp/agentPool.ts";
import { AcpAgentHost } from "./ahp/acpBridge.ts";
import {
  addAgentCommand,
  editAgentsConfigCommand,
} from "./acp/agents/commands.ts";
import {
  SessionViewProvider,
  type SessionTarget,
} from "./sessionViewProvider.ts";
import { toggleGroupSessionsByCwd } from "./settings.ts";
import { SessionsTreeProvider } from "./treeProvider.ts";

export function activate(context: vscode.ExtensionContext) {
  const agentPool = new AgentConnectionPool();
  const sessionViewProvider = new SessionViewProvider(
    context.extensionUri,
    agentPool,
  );
  const treeProvider = new SessionsTreeProvider(agentPool, sessionViewProvider);

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
  );

  void startAgentHost(context, agentPool);
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

async function startAgentHost(
  context: vscode.ExtensionContext,
  agentPool: AgentConnectionPool,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("acpcode.agentHost");
  if (!config.get<boolean>("enabled", false)) {
    return;
  }
  const port = config.get<number>("port", 8765);
  const output = vscode.window.createOutputChannel("ACP Code: Agent Host");
  const host = new AcpAgentHost(agentPool, output);
  context.subscriptions.push(host, output);
  try {
    await host.server.listen(port, agentHostToken(context));
    output.appendLine(`Listening on 127.0.0.1:${port}`);
  } catch (err) {
    // ponytail: with several windows open only the first one binds the port;
    // the others' Chat talks to that window's host. Per-window ports if
    // sessions ever need to run in their own window's extension host.
    output.appendLine(`Couldn't listen on 127.0.0.1:${port}: ${String(err)}`);
    host.dispose();
  }
}

async function connectChatToAgentHost(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showErrorMessage(
      "Open a folder first: VS Code reads remote agent hosts from workspace settings.",
    );
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    "This writes the agent host's address and connection token to this workspace's settings (.vscode/settings.json). Don't commit that file with the token in it.",
    { modal: true },
    "Continue",
  );
  if (confirm !== "Continue") {
    return;
  }
  const port = vscode.workspace
    .getConfiguration("acpcode.agentHost")
    .get<number>("port", 8765);
  const entry = {
    name: AGENT_HOST_NAME,
    address: `127.0.0.1:${port}`,
    connectionToken: agentHostToken(context),
  };
  const chat = vscode.workspace.getConfiguration("chat");
  const hosts =
    chat.get<{ name: string }[]>("workspaceRemoteAgentHosts", []) ?? [];
  try {
    await chat.update(
      "workspaceRemoteAgentHosts",
      [...hosts.filter(h => h.name !== AGENT_HOST_NAME), entry],
      vscode.ConfigurationTarget.Workspace,
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
