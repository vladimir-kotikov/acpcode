// Message contract between the extension host (src/sessionViewProvider.ts)
// and the session transcript webview (src/webview/sessionView.ts).

import type {
  PermissionOption,
  SessionId,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

export interface SessionViewMeta {
  agentName: string;
  sessionId: SessionId;
  // Not otherwise needed for rendering — carried so the webview can persist
  // it via `vscode.setState()`, which is what lets an editor tab restore
  // itself (see the WebviewPanelSerializer in sessionViewProvider.ts) across
  // a window reload with enough to re-attach the same session.
  cwd: string;
  title?: string | null;
  // Whether this agent supports `_session/steering` — if not, the composer
  // falls back to blocking send while busy, since calling `session/prompt`
  // again mid-turn would interrupt it instead of injecting into it.
  canSteer: boolean;
}

// What the webview persists via `vscode.setState()`/`vscode.getState()` (see
// sessionView.ts) and what `WebviewPanelSerializer.deserializeWebviewPanel`
// (sessionViewProvider.ts) receives back for a restored editor tab — shared
// so the two sides can't drift out of sync on the shape again (they did:
// deserializeWebviewPanel was reading fields directly off this object as if
// it *were* a SessionViewMeta, instead of off its nested `.meta`).
export interface SessionViewPersistedState {
  meta: SessionViewMeta;
  draftText: string;
}

export type HostToSessionViewMessage =
  // Sent the moment attachSession starts, before the agent connection (which
  // may mean spawning a fresh subprocess) has even resolved — lets the
  // webview show a "Starting bridge…" spinner instead of sitting blank for
  // however long that cold start takes. `loading` (below) follows once a
  // connection exists and carries the real session meta.
  | { type: "connecting" }
  | { type: "loading"; meta: SessionViewMeta }
  // The session this view was showing was deleted — reset to "no session".
  | { type: "closed" }
  | { type: "update"; sessionId: SessionId; update: SessionUpdate }
  // A batch of already-known updates delivered as one message (history
  // replay, or seeded from another view already showing this session) — one
  // reducer transition instead of N, so the transcript doesn't visibly
  // rebuild block-by-block. `busy`: whether a prompt is genuinely still in
  // flight host-side, so a reconnecting view doesn't assume idle.
  | {
      type: "replayBatch";
      sessionId: SessionId;
      updates: SessionUpdate[];
      busy: boolean;
    }
  // `forkable`: this specific failure was the session being currently owned
  // by a live `claude --bg` background-agent process elsewhere — ACP has no
  // attach method, so forking (a new session id resumed from the same
  // history) is the only available fallback. Set so the webview can offer it.
  | { type: "error"; message: string; forkable?: boolean }
  | { type: "promptStopped"; sessionId: SessionId; stopReason: StopReason }
  | {
      type: "permissionRequest";
      requestId: string;
      sessionId: SessionId;
      toolCall: ToolCallUpdate;
      options: PermissionOption[];
    }
  | { type: "permissionResolved"; requestId: string };

export type SessionViewToHostMessage =
  | { type: "ready" }
  | { type: "sendPrompt"; text: string }
  | { type: "cancelPrompt" }
  | { type: "permissionResponse"; requestId: string; optionId: string | null }
  | { type: "forkSession" };
