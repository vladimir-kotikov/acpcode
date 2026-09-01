import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { AgentClient } from "./acp/agentClient.ts";
import { getAgents, type AgentConfig } from "./acp/agents/config.ts";
import type {
  HostToWebviewMessage,
  ProfileDescriptor,
  WebviewToHostMessage,
} from "./shared/protocol.ts";
import { resolveCwd } from "./workspaceUtils.ts";

/** Chat webview, currently dormant — not registered in extension.ts while the
 *  sessions tree view is being built out. Kept buildable so it's cheap to
 *  wire back in later. */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private client?: AgentClient;
  private subscriptions: vscode.Disposable[] = [];
  private currentAgent: string;
  private currentSessionId?: string;
  private readonly extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.currentAgent = getAgents()[0]?.name ?? "";
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      void this.handleMessage(message);
    });

    webviewView.onDidDispose(() => this.disposeClient());
  }

  async newSession(): Promise<void> {
    if (!this.client) {
      return;
    }
    const response = await this.client.newSession();
    this.currentSessionId = response.sessionId;
    this.post({
      type: "sessionStarted",
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    });
  }

  async refreshSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    const sessions = await this.client.listSessions();
    this.post({ type: "sessions", sessions });
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready": {
        const profiles: ProfileDescriptor[] = getAgents().map(agent => ({
          name: agent.name,
        }));
        this.post({ type: "profiles", profiles, current: this.currentAgent });
        await this.connect(this.currentAgent);
        break;
      }
      case "selectProfile": {
        await this.connect(message.profile);
        break;
      }
      case "listSessions": {
        await this.refreshSessions();
        break;
      }
      case "newSession": {
        await this.newSession();
        break;
      }
      case "selectSession": {
        this.currentSessionId = message.sessionId;
        const response = await this.client?.loadSession(message.sessionId);
        this.post({
          type: "sessionStarted",
          sessionId: message.sessionId,
          modes: response?.modes,
          configOptions: response?.configOptions,
        });
        break;
      }
      case "sendPrompt": {
        if (!this.client || !this.currentSessionId) {
          return;
        }
        try {
          const stopReason = await this.client.prompt(
            this.currentSessionId,
            message.text,
          );
          this.post({
            type: "promptStopped",
            sessionId: this.currentSessionId,
            stopReason,
          });
        } catch (err) {
          this.post({ type: "error", message: String(err) });
        }
        break;
      }
      case "cancelPrompt": {
        if (this.currentSessionId) {
          this.client?.cancelPrompt(this.currentSessionId);
        }
        break;
      }
      case "setConfigOption": {
        if (this.currentSessionId) {
          await this.client?.setConfigOption(
            this.currentSessionId,
            message.configId,
            message.value,
          );
        }
        break;
      }
      case "permissionResponse": {
        this.client?.resolvePermission(message.requestId, message.optionId);
        break;
      }
    }
  }

  private async connect(agentName: string): Promise<void> {
    const agent: AgentConfig | undefined =
      getAgents().find(a => a.name === agentName) ?? getAgents()[0];
    if (!agent) {
      this.post({
        type: "connectionState",
        state: "error",
        error: "No agents configured",
      });
      return;
    }
    this.currentAgent = agent.name;
    this.currentSessionId = undefined;

    this.disposeClient();
    this.client = new AgentClient(resolveCwd(), agent.name);
    this.subscriptions.push(
      this.client.onConnectionStateChanged(({ state, error }) =>
        this.post({ type: "connectionState", state, error }),
      ),
      this.client.onSessionUpdate(({ sessionId, update }) =>
        this.post({ type: "sessionUpdate", sessionId, update }),
      ),
      this.client.onPermissionRequest(
        ({ requestId, sessionId, toolCall, options }) =>
          this.post({
            type: "permissionRequest",
            requestId,
            sessionId,
            toolCall,
            options,
          }),
      ),
      this.client.onPermissionResolved(({ requestId }) =>
        this.post({ type: "permissionResolved", requestId }),
      ),
    );

    try {
      await this.client.connect(agent);
      await this.refreshSessions();
    } catch {
      // connectionState "error" already fired via onConnectionStateChanged.
    }
  }

  private disposeClient(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions = [];
    this.client?.dispose();
    this.client = undefined;
  }

  private post(message: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css"),
    );
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
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
