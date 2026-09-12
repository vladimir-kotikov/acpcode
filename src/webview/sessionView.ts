import { html, render } from "htm/preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import { match } from "ts-pattern";
import type {
  HostToSessionViewMessage,
  SessionViewPersistedState,
  SessionViewToHostMessage,
} from "../shared/sessionViewProtocol.ts";
import { type Action, initialState, reduce } from "./state.ts";
import { Transcript } from "./transcript.ts";

declare function acquireVsCodeApi(): {
  postMessage(message: SessionViewToHostMessage): void;
  getState(): SessionViewPersistedState | undefined;
  setState(state: SessionViewPersistedState): void;
};

const vscode = acquireVsCodeApi();

function Root() {
  const [state, dispatch] = useReducer(reduce, initialState);

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
    const listener = (event: MessageEvent<HostToSessionViewMessage>) =>
      dispatch(
        match(event.data)
          .returnType<Action>()
          .with({ type: "connecting" }, message => message)
          .with({ type: "loading" }, message => ({
            type: "loading",
            meta: message.meta,
            restoredDraftText:
              vscode.getState()?.meta?.sessionId === message.meta.sessionId
                ? vscode.getState()?.draftText
                : undefined,
          }))
          .with({ type: "update" }, message => ({
            ...message,
            type: "sessionUpdate",
          }))
          .with({ type: "replayBatch" }, message => message)
          .with({ type: "error" }, message => message)
          .with({ type: "promptStopped" }, message => message)
          .with({ type: "permissionRequest" }, message => message)
          .with({ type: "permissionResolved" }, message => message)
          .with({ type: "closed" }, message => message)
          .exhaustive(),
      );

    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const onSend = (text: string): void => {
    atBottomRef.current = true;
    // Matches Composer's own steeringBlocked/canSend condition: a send while
    // already busy only reaches here at all when the agent supports
    // steering (Composer disables the button otherwise) — that's exactly
    // the case needing the provisional bubble.
    const isSteering = state.busy && !!state.meta?.canSteer;
    dispatch({
      type: "draftSent",
      pendingSteerText: isSteering ? text : undefined,
    });
    dispatch({ type: "sendStart" });
    vscode.postMessage({ type: "sendPrompt", text });
  };

  const onRespond = (requestId: string, optionId: string): void => {
    dispatch({ type: "localPermissionResponse", requestId, optionId });
    vscode.postMessage({ type: "permissionResponse", requestId, optionId });
  };

  return html`<${Transcript}
    state=${state}
    atBottomRef=${atBottomRef}
    onSend=${onSend}
    onCancel=${() => vscode.postMessage({ type: "cancelPrompt" })}
    onRespond=${onRespond}
    onFork=${() => vscode.postMessage({ type: "forkSession" })}
    onDraftChange=${(text: string) => dispatch({ type: "draftChanged", text })}
  />`;
}

render(html`<${Root} />`, document.getElementById("root")!);
