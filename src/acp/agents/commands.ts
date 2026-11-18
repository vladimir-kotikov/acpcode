import * as vscode from "vscode";
import { getAgents, saveAgents } from "../../settings.ts";
import { withAgentCli } from "../bridges.ts";
import type { AgentConfig } from "./config.ts";
import { KINDS } from "./kinds.ts";

/** Read-only: says how to install the kind's agent CLI if it's missing, but
 *  never installs it. (The ACP bridge needs no check: it's installed on first
 *  connect.) */
function missingCli(kind: AgentConfig["kind"]): string | undefined {
  try {
    withAgentCli(kind, process.env);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

export const editAgentsConfigCommand = async () =>
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "acpcode.agents",
  );

export const addAgentCommand = async (): Promise<void> => {
  const kindPick = await vscode.window.showQuickPick(
    Object.entries(KINDS).map(([id, kind]) => ({
      label: kind.label,
      description: kind.description,
      id: id as AgentConfig["kind"],
    })),
    { title: "Add Agent", placeHolder: "Select an agent kind" },
  );
  if (!kindPick) {
    return;
  }

  const missing = missingCli(kindPick.id);
  if (missing) {
    void vscode.window.showErrorMessage(missing);
    return;
  }

  const name = await vscode.window.showInputBox({
    title: "Add Agent",
    prompt: "Display name for this agent",
    placeHolder: `e.g. ${kindPick.label} (work)`,
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
    kind: kindPick.id,
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
};
