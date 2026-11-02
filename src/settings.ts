import * as vscode from "vscode";
import type { AgentConfig } from "./acp/agents/config.ts";

export const getGroupSessionsByCwd = () =>
  vscode.workspace
    .getConfiguration("acpcode")
    .get<boolean>("groupSessionsByCwd", false);

export const toggleGroupSessionsByCwd = async () =>
  await vscode.workspace
    .getConfiguration("acpcode")
    .update(
      "groupSessionsByCwd",
      !getGroupSessionsByCwd(),
      vscode.ConfigurationTarget.Global,
    );

export const getAgents = (): AgentConfig[] =>
  vscode.workspace.getConfiguration("acpcode").get<AgentConfig[]>("agents", []);

export const getAgent = (name: string): AgentConfig | undefined =>
  getAgents().find(agent => agent.name === name);

export async function saveAgents(agents: AgentConfig[]): Promise<void> {
  const config = vscode.workspace.getConfiguration("acpcode");
  await config.update("agents", agents, vscode.ConfigurationTarget.Global);
}
