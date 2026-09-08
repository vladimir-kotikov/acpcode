import * as vscode from "vscode";
import { AgentConnectionPool } from "./acp/agentPool.ts";
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
  );
}

export function deactivate() {}
