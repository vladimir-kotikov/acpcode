import * as crypto from "node:crypto";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import type { AgentConnectionPool } from "./acp/agentPool.ts";
import { getAgents } from "./acp/agents/config.ts";
import type { HostToSessionViewMessage, SessionViewToHostMessage } from "./shared/sessionViewProtocol.ts";
import { resolveCwd } from "./workspaceUtils.ts";

export interface SessionTarget {
	agentName: string;
	sessionId: string;
	/** The session's own recorded working directory (`SessionInfo.cwd`), NOT
	 *  wherever this connection happens to be spawned — required to actually
	 *  locate the session's on-disk transcript when loading it. */
	cwd: string;
	title?: string | null;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "sessionView.js"));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.css"));
	const hljsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "hljs-theme.css"));
	const nonce = crypto.randomBytes(16).toString("hex");

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
	/>
	<link href="${styleUri}" rel="stylesheet" />
	<link href="${hljsStyleUri}" rel="stylesheet" />
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Read-only session transcript viewer. Lives in its own sidebar section
 *  (separate from the sessions tree); "Open in Editor" mirrors the current
 *  transcript, as a point-in-time snapshot, into a full editor tab webview
 *  panel using the same renderer bundle. */
export class SessionViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private readonly extensionUri: vscode.Uri;
	private readonly pool: AgentConnectionPool;
	private view?: vscode.WebviewView;
	private viewReady = false;
	private current?: SessionTarget;
	private buffer: SessionUpdate[] = [];
	private subscription?: vscode.Disposable;

	constructor(extensionUri: vscode.Uri, pool: AgentConnectionPool) {
		this.extensionUri = extensionUri;
		this.pool = pool;
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.viewReady = false;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
		webviewView.webview.html = renderHtml(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage((message: SessionViewToHostMessage) => {
			if (message.type === "ready") {
				this.viewReady = true;
				this.replayInto(webviewView.webview);
			}
		});
		webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = undefined;
				this.viewReady = false;
			}
		});
	}

	async openSession(target: SessionTarget): Promise<void> {
		await vscode.commands.executeCommand("acpcode.sessionView.focus");

		const agent = getAgents().find(candidate => candidate.name === target.agentName);
		if (!agent) {
			this.postToView({ type: "error", message: `Agent "${target.agentName}" is no longer configured.` });
			return;
		}

		if (this.current?.agentName !== target.agentName) {
			this.subscription?.dispose();
			const client = await this.pool.connect(agent, resolveCwd());
			this.subscription = client.onSessionUpdate(event => {
				if (event.sessionId !== this.current?.sessionId) {
					return;
				}
				this.buffer.push(event.update);
				this.postToView({ type: "update", sessionId: event.sessionId, update: event.update });
			});
		}

		this.current = target;
		this.buffer = [];
		this.postToView({
			type: "loading",
			meta: { agentName: target.agentName, sessionId: target.sessionId, title: target.title },
		});

		try {
			const client = await this.pool.connect(agent, resolveCwd());
			await client.loadSession(target.sessionId, target.cwd);
		} catch (err) {
			this.postToView({ type: "error", message: String(err) });
		}
	}

	/** Opens a snapshot of a session in a full editor tab. Passing `target`
	 *  (e.g. from a tree item's context menu/inline button) first loads that
	 *  session into the sidebar section, same as clicking it; with no
	 *  argument it snapshots whatever the sidebar section currently shows.
	 *  Live updates after this point only continue in the sidebar view. */
	async openInEditor(target?: SessionTarget): Promise<void> {
		if (target) {
			await this.openSession(target);
		}
		if (!this.current) {
			void vscode.window.showInformationMessage("Open a session first.");
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			"acpcode.sessionViewEditor",
			`${this.current.agentName} — ${this.current.title ?? this.current.sessionId}`,
			vscode.ViewColumn.Active,
			{ enableScripts: true, localResourceRoots: [this.extensionUri] },
		);
		panel.webview.html = renderHtml(panel.webview, this.extensionUri);
		panel.webview.onDidReceiveMessage((message: SessionViewToHostMessage) => {
			if (message.type === "ready") {
				this.replayInto(panel.webview);
			}
		});
	}

	private replayInto(webview: vscode.Webview): void {
		if (!this.current) {
			return;
		}
		void webview.postMessage({
			type: "loading",
			meta: { agentName: this.current.agentName, sessionId: this.current.sessionId, title: this.current.title },
		} satisfies HostToSessionViewMessage);
		for (const update of this.buffer) {
			void webview.postMessage({
				type: "update",
				sessionId: this.current.sessionId,
				update,
			} satisfies HostToSessionViewMessage);
		}
	}

	private postToView(message: HostToSessionViewMessage): void {
		if (this.view && this.viewReady) {
			void this.view.webview.postMessage(message);
		}
	}

	dispose(): void {
		this.subscription?.dispose();
	}
}
