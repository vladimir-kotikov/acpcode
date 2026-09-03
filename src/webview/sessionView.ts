import { html, render } from "htm/preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import type {
  HostToSessionViewMessage,
  SessionViewToHostMessage,
} from "../shared/sessionViewProtocol.ts";
import { initialState, reduce, Transcript, type Action } from "./transcript.ts";

declare function acquireVsCodeApi(): {
  postMessage(message: SessionViewToHostMessage): void;
};

const vscode = acquireVsCodeApi();

function Root() {
  const [state, dispatch] = useReducer(reduce, initialState);
  // window's "message" listener is wired once (empty deps below); it needs
  // the current dispatch through a ref rather than a stale closure.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    const listener = (event: MessageEvent<HostToSessionViewMessage>) => {
      const message = event.data;
      let action: Action;
      switch (message.type) {
        case "loading":
          action = { type: "loading", meta: message.meta };
          break;
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
      }
      dispatchRef.current(action);
    };
    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  function onSend(text: string): void {
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
    onSend=${onSend}
    onCancel=${onCancel}
    onRespond=${onRespond}
    onFork=${onFork}
    onDraftChange=${onDraftChange}
  />`;
}

render(html`<${Root} />`, document.getElementById("root")!);
