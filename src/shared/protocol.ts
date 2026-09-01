// Message contract between the extension host (src/sidebarProvider.ts) and the
// webview UI (src/webview/main.ts). Kept dependency-free so it can be bundled
// into both the node and browser esbuild targets.

import type {
  PermissionOption,
  SessionConfigOption,
  SessionId,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

export interface ProfileDescriptor {
  name: string;
}

export type HostToWebviewMessage =
  | { type: "profiles"; profiles: ProfileDescriptor[]; current: string }
  | {
      type: "connectionState";
      state: "connecting" | "connected" | "error";
      error?: string;
    }
  | { type: "sessions"; sessions: SessionInfo[] }
  | {
      type: "sessionStarted";
      sessionId: SessionId;
      modes?: SessionModeState | null;
      configOptions?: SessionConfigOption[] | null;
    }
  | { type: "sessionUpdate"; sessionId: SessionId; update: SessionUpdate }
  | {
      type: "permissionRequest";
      requestId: string;
      sessionId: SessionId;
      toolCall: ToolCallUpdate;
      options: PermissionOption[];
    }
  | { type: "permissionResolved"; requestId: string }
  | { type: "promptStopped"; sessionId: SessionId; stopReason: StopReason }
  | { type: "error"; message: string };

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "selectProfile"; profile: string }
  | { type: "listSessions" }
  | { type: "newSession" }
  | { type: "selectSession"; sessionId: SessionId }
  | { type: "sendPrompt"; text: string }
  | { type: "cancelPrompt" }
  | { type: "setConfigOption"; configId: string; value: string | boolean }
  | { type: "permissionResponse"; requestId: string; optionId: string | null };
