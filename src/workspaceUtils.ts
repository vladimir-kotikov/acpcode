import * as os from "node:os";
import * as vscode from "vscode";

export function resolveCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}
