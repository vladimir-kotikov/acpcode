// Message contract between the extension host (src/sessionViewProvider.ts)
// and the read-only session transcript webview (src/webview/sessionView.ts).
// One-directional except for the "ready" handshake: this view never sends a
// prompt, permission response, or config change back to the host.

import type { SessionId, SessionUpdate } from "@agentclientprotocol/sdk";

export interface SessionViewMeta {
	agentName: string;
	sessionId: SessionId;
	title?: string | null;
}

export type HostToSessionViewMessage =
	| { type: "loading"; meta: SessionViewMeta }
	| { type: "update"; sessionId: SessionId; update: SessionUpdate }
	| { type: "error"; message: string };

export type SessionViewToHostMessage = { type: "ready" };
