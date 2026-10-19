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
  // Whether this agent's `promptCapabilities.image` is set — a pasted/dropped
  // image with no source file (clipboard bytes only, nothing on disk to point
  // a `resource_link` at) has no fallback when this is false, so the composer
  // needs to know up front rather than discovering it only once a send fails.
  // A file (or an image that DOES have a source path) never needs this check:
  // `resource_link` is baseline-supported by every agent regardless.
  canAttachImages: boolean;
}

// One attached file/image, in whichever of the two shapes it was captured:
// `uri` when a real source path is known (drag from Explorer/tabs/Finder,
// the explorer/tab context-menu command, or a paste matched back to its
// source editor selection — see RecentSelectionTracker in
// sessionViewProvider.ts); `data` (base64) when it's pasted bytes with no
// path at all (a screenshot-tool clipboard image). Never both — `uri` is
// preferred whenever available since it lets the agent read the file itself
// instead of inlining it. `line`/`endLine` are only ever set on a
// paste-matched-to-source attachment.
export interface Attachment {
  id: string;
  name: string;
  mimeType?: string;
  uri?: string;
  data?: string;
  line?: number;
  endLine?: number;
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
  // The agent's own history-reset command (e.g. `/clear`) was just sent for
  // this session — see AgentClient.onTranscriptReset. Empties the transcript
  // client-side; still the same session, `loading`/`closed` don't apply.
  | { type: "reset"; sessionId: SessionId }
  | {
      type: "permissionRequest";
      requestId: string;
      sessionId: SessionId;
      toolCall: ToolCallUpdate;
      options: PermissionOption[];
    }
  | { type: "permissionResolved"; requestId: string }
  // Pushed from the explorer/tab "Attach to ACP Code Chat" context-menu
  // command (sessionViewProvider.ts's attachFilesToChat) — targets whichever
  // session is active (see SessionViewProvider.activeSession); carries every
  // selected file in one message on a multi-select attach.
  | { type: "attachFile"; attachments: Attachment[] }
  // Reply to a `resolvePastedSource` request — `attachment` is undefined when
  // the pasted text didn't match anything in RecentSelectionTracker's buffer.
  | {
      type: "pastedSourceResolved";
      requestId: string;
      attachment: Attachment | undefined;
    };

export type SessionViewToHostMessage =
  | { type: "ready" }
  | { type: "sendPrompt"; text: string; attachments: Attachment[] }
  | { type: "cancelPrompt" }
  | { type: "permissionResponse"; requestId: string; optionId: string | null }
  | { type: "forkSession" }
  // The user picked a different value for a model/effort/mode selector chip
  // in the composer — see Composer's ConfigChip and AgentClient.setConfigOption.
  | { type: "setConfigOption"; configId: string; value: string | boolean }
  // A `read` tool card's file link — opens `path` in the current window's
  // editor area rather than in the webview, which has no editor of its own.
  | { type: "openFile"; path: string; line?: number }
  // A plain-text paste landed in the composer — ask the host whether it
  // matches a recently-selected editor range (see RecentSelectionTracker) so
  // it can be attached as "pasted from this file" alongside the text.
  // `requestId` correlates the reply since paste events aren't necessarily
  // answered in order.
  | { type: "resolvePastedSource"; requestId: string; text: string };
