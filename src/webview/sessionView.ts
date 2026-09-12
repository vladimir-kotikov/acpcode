import { html, render } from "htm/preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import type {
  HostToSessionViewMessage,
  SessionViewPersistedState,
  SessionViewToHostMessage,
} from "../shared/sessionViewProtocol.ts";
import { initialState, reduce, type Action } from "./state.ts";
import { Transcript } from "./transcript.ts";

declare function acquireVsCodeApi(): {
  postMessage(message: SessionViewToHostMessage): void;
  getState(): SessionViewPersistedState | undefined;
  setState(state: SessionViewPersistedState): void;
};

const vscode = acquireVsCodeApi();

function Root() {
  const [state, dispatch] = useReducer(reduce, initialState);
  // window's "message" listener is wired once (empty deps below); it needs
  // the current dispatch through a ref rather than a stale closure.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  // Owned here (not inside Transcript) so onSend below can force it
  // directly — see Transcript's own comment on the scroll-tracking effect.
  const atBottomRef = useRef(true);

  // Single spot persisting both halves of PersistedState — covers both the
  // session-changed case (meta updates on "loading") and every keystroke in
  // the composer (draftText updates), so a reload mid-typing doesn't lose it.
  useEffect(() => {
    if (state.meta) {
      vscode.setState({ meta: state.meta, draftText: state.draftText });
    }
  }, [state.meta, state.draftText]);

  useEffect(() => {
    const listener = (event: MessageEvent<HostToSessionViewMessage>) => {
      const message = event.data;
      let action: Action;
      switch (message.type) {
        case "connecting":
          action = { type: "connecting" };
          break;
        case "loading": {
          const persisted = vscode.getState();
          const restoredDraftText =
            persisted?.meta?.sessionId === message.meta.sessionId
              ? persisted.draftText
              : undefined;
          action = { type: "loading", meta: message.meta, restoredDraftText };
          break;
        }
        case "update":
          action = {
            type: "sessionUpdate",
            sessionId: message.sessionId,
            update: message.update,
          };
          break;
        case "replayBatch":
          action = {
            type: "replayBatch",
            sessionId: message.sessionId,
            updates: message.updates,
            busy: message.busy,
          };
          break;
        case "error":
          action = {
            type: "error",
            text: message.message,
            forkable: message.forkable,
          };
          break;
        case "promptStopped":
          action = {
            type: "promptStopped",
            sessionId: message.sessionId,
            stopReason: message.stopReason,
          };
          break;
        case "permissionRequest":
          action = {
            type: "permissionRequest",
            requestId: message.requestId,
            sessionId: message.sessionId,
            toolCall: message.toolCall,
            options: message.options,
          };
          break;
        case "permissionResolved":
          action = { type: "permissionResolved", requestId: message.requestId };
          break;
        case "closed":
          action = { type: "closed" };
          break;
      }
      dispatchRef.current(action);
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  function onSend(text: string): void {
    atBottomRef.current = true;
    dispatch({ type: "draftSent" });
    dispatch({ type: "sendStart" });
    vscode.postMessage({ type: "sendPrompt", text });
  }
  function onCancel(): void {
    vscode.postMessage({ type: "cancelPrompt" });
  }
  function onRespond(requestId: string, optionId: string): void {
    dispatch({ type: "localPermissionResponse", requestId, optionId });
    vscode.postMessage({ type: "permissionResponse", requestId, optionId });
  }
  function onFork(): void {
    vscode.postMessage({ type: "forkSession" });
  }
  function onDraftChange(text: string): void {
    dispatch({ type: "draftChanged", text });
  }

  return html`<${Transcript}
    state=${state}
    atBottomRef=${atBottomRef}
    onSend=${onSend}
    onCancel=${onCancel}
    onRespond=${onRespond}
    onFork=${onFork}
    onDraftChange=${onDraftChange}
  />`;
}

render(html`<${Root} />`, document.getElementById("root")!);
