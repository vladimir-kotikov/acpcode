import * as vscode from "vscode";

export type SessionScope = "all" | "workspace";

export const getSessionScope = () =>
  vscode.workspace
    .getConfiguration("acpcode")
    .get<SessionScope>("sessionScope", "all");

export const setSessionScope = async (scope: SessionScope) =>
  await vscode.workspace
    .getConfiguration("acpcode")
    .update("sessionScope", scope, vscode.ConfigurationTarget.Global);

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
