import * as vscode from "vscode";

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
