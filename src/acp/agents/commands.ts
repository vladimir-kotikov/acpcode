import * as vscode from "vscode";
import { getAgents, saveAgents, type AgentConfig } from "./config.ts";
import { AGENT_KINDS } from "./kinds.ts";

export async function editAgentsConfigCommand(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "acpcode.agents",
  );
}

export async function addAgentCommand(): Promise<void> {
  const kindPick = await vscode.window.showQuickPick(
    AGENT_KINDS.map(agentKind => ({
      label: agentKind.label,
      description: agentKind.description,
      agentKind,
    })),
    { title: "Add Agent", placeHolder: "Select an agent kind" },
  );
  if (!kindPick) {
    return;
  }

  const installCheck = kindPick.agentKind.checkInstalled?.() ?? { ok: true };
  if (!installCheck.ok) {
    void vscode.window.showErrorMessage(installCheck.message);
    return;
  }

  const name = await vscode.window.showInputBox({
    title: "Add Agent",
    prompt: "Display name for this agent",
    placeHolder: `e.g. ${kindPick.agentKind.label} (work)`,
    validateInput: value => (value.trim() ? undefined : "Name is required"),
  });
  if (!name) {
    return;
  }

  const existing = getAgents();
  if (existing.some(agent => agent.name === name.trim())) {
    void vscode.window.showErrorMessage(
      `An agent named "${name.trim()}" already exists.`,
    );
    return;
  }

  const agent: AgentConfig = {
    name: name.trim(),
    kind: kindPick.agentKind.id,
    env: {},
  };
  await saveAgents([...existing, agent]);

  const editEnv = "Edit environment variables…";
  const choice = await vscode.window.showInformationMessage(
    `Agent "${agent.name}" added.`,
    editEnv,
  );
  if (choice === editEnv) {
    await editAgentsConfigCommand();
  }
}
