import type { HostToSessionViewMessage, SessionViewToHostMessage } from "../shared/sessionViewProtocol.ts";
import { el, TranscriptRenderer } from "./transcript.ts";

declare function acquireVsCodeApi(): {
	postMessage(message: SessionViewToHostMessage): void;
};

const vscode = acquireVsCodeApi();

const root = document.getElementById("root")!;
const header = el("div", "session-header session-header-placeholder", "No session selected");
const log = el("div", "chat-log session-log");
root.append(header, log);

const renderer = new TranscriptRenderer(log);
let currentSessionId: string | undefined;

window.addEventListener("message", (event: MessageEvent<HostToSessionViewMessage>) => {
	const message = event.data;
	switch (message.type) {
		case "loading": {
			currentSessionId = message.meta.sessionId;
			header.classList.remove("session-header-placeholder");
				header.textContent = `${message.meta.agentName} — ${message.meta.title ?? message.meta.sessionId}`;
			renderer.clear();
			renderer.appendLoadingNote("Loading…");
			break;
		}
		case "update": {
			if (message.sessionId !== currentSessionId) {
				break;
			}
			renderer.applyUpdate(message.update);
			break;
		}
		case "error": {
			renderer.appendErrorNote(message.message);
			break;
		}
	}
});

vscode.postMessage({ type: "ready" });
