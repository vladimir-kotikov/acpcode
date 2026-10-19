import { html, render } from "htm/preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import { match } from "ts-pattern";
import type {
  Attachment,
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

  // Resolves a `resolvePastedSource` round-trip by its requestId — a
  // side-channel outside the reducer (there's nothing to render while it's
  // pending, just a Promise for the composer's paste handler to await),
  // populated/drained from the message listener below.
  const pastedSourceWaiters = useRef(
    new Map<string, (attachment: Attachment | undefined) => void>(),
  ).current;

  useEffect(() => {
    const listener = (event: MessageEvent<HostToSessionViewMessage>) => {
      const message = event.data;
      if (message.type === "pastedSourceResolved") {
        pastedSourceWaiters.get(message.requestId)?.(message.attachment);
        pastedSourceWaiters.delete(message.requestId);
        return;
      }
      dispatch(
        match(message)
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
          .with({ type: "reset" }, message => message)
          .with({ type: "permissionRequest" }, message => message)
          .with({ type: "permissionResolved" }, message => message)
          .with({ type: "closed" }, message => message)
          .exhaustive(),
      );
    };

    window.addEventListener("message", listener);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", listener);
  }, []);

  const onSend = (text: string, attachments: Attachment[]): void => {
    atBottomRef.current = true;
    // Matches Composer's own steeringBlocked/canSend condition: a send while
    // already busy only reaches here at all when the agent supports
    // steering (Composer disables the button otherwise) — that's exactly
    // the case needing the provisional bubble.
    const isSteering = state.busy && !!state.meta?.canSteer;
    dispatch({
      type: "draftSent",
      pendingSteerText: isSteering ? text : undefined,
      pendingSteerAttachments: isSteering ? attachments : undefined,
    });
    dispatch({ type: "sendStart" });
    vscode.postMessage({ type: "sendPrompt", text, attachments });
  };

  const onRespond = (requestId: string, optionId: string): void => {
    dispatch({ type: "localPermissionResponse", requestId, optionId });
    vscode.postMessage({ type: "permissionResponse", requestId, optionId });
  };

  const onOpenFile = (path: string, line?: number): void => {
    vscode.postMessage({ type: "openFile", path, line });
  };

  const onSetConfigOption = (
    configId: string,
    value: string | boolean,
  ): void => {
    vscode.postMessage({ type: "setConfigOption", configId, value });
  };

  const onAttachmentsAdded = (attachments: Attachment[]): void =>
    dispatch({ type: "attachmentsAdded", attachments });

  const onAttachmentRemoved = (id: string): void =>
    dispatch({ type: "attachmentRemoved", id });

  const onAttachError = (message: string): void =>
    dispatch({ type: "error", message });

  // Asks the host whether `text` (a plain-text paste) matches a recently
  // selected editor range — see RecentSelectionTracker in
  // sessionViewProvider.ts. Resolves `undefined` on no match; never rejects.
  const onResolvePastedSource = (
    text: string,
  ): Promise<Attachment | undefined> =>
    new Promise(resolve => {
      const requestId = crypto.randomUUID();
      pastedSourceWaiters.set(requestId, resolve);
      vscode.postMessage({ type: "resolvePastedSource", requestId, text });
    });

  return html`<${Transcript}
    state=${state}
    atBottomRef=${atBottomRef}
    onSend=${onSend}
    onCancel=${() => vscode.postMessage({ type: "cancelPrompt" })}
    onRespond=${onRespond}
    onFork=${() => vscode.postMessage({ type: "forkSession" })}
    onOpenFile=${onOpenFile}
    onDraftChange=${(text: string) => dispatch({ type: "draftChanged", text })}
    onSetConfigOption=${onSetConfigOption}
    onAttachmentsAdded=${onAttachmentsAdded}
    onAttachmentRemoved=${onAttachmentRemoved}
    onAttachError=${onAttachError}
    onResolvePastedSource=${onResolvePastedSource}
  />`;
}

render(html`<${Root} />`, document.getElementById("root")!);
