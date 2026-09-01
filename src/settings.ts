import * as vscode from "vscode";

export type SessionScope = "all" | "workspace";

export function getSessionScope(): SessionScope {
	return vscode.workspace.getConfiguration("acpcode").get<SessionScope>("sessionScope", "all");
}

export async function setSessionScope(scope: SessionScope): Promise<void> {
	await vscode.workspace.getConfiguration("acpcode").update("sessionScope", scope, vscode.ConfigurationTarget.Global);
}

export function getGroupSessionsByCwd(): boolean {
	return vscode.workspace.getConfiguration("acpcode").get<boolean>("groupSessionsByCwd", false);
}

export async function toggleGroupSessionsByCwd(): Promise<void> {
	const config = vscode.workspace.getConfiguration("acpcode");
	await config.update("groupSessionsByCwd", !getGroupSessionsByCwd(), vscode.ConfigurationTarget.Global);
}
