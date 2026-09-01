import * as os from "node:os";
import * as vscode from "vscode";

export const resolveCwd = () =>
  vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
