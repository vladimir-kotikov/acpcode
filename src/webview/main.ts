import type {
  ContentBlock,
  PermissionOption,
  SessionConfigOption,
  SessionId,
  SessionInfo,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
  HostToWebviewMessage,
  ProfileDescriptor,
  WebviewToHostMessage,
} from "../shared/protocol.ts";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
};

const vscode = acquireVsCodeApi();

function post(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

interface ToolCardHandle {
  root: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
}

interface State {
  profiles: ProfileDescriptor[];
  currentProfile: string;
  connection: "connecting" | "connected" | "error";
  sessions: SessionInfo[];
  currentSessionId: SessionId | undefined;
  configOptions: SessionConfigOption[];
  busy: boolean;
  toolCards: Map<string, ToolCardHandle>;
  lastMessageBubble: { role: string; el: HTMLElement } | undefined;
}

const state: State = {
  profiles: [],
  currentProfile: "",
  connection: "connecting",
  sessions: [],
  currentSessionId: undefined,
  configOptions: [],
  busy: false,
  toolCards: new Map(),
  lastMessageBubble: undefined,
};

const root = document.getElementById("root")!;

const topBar = el("div", "topbar");
const profileSelect = el("select", "profile-select");
const statusDot = el("span", "status-dot");
topBar.append(profileSelect, statusDot);

const configBar = el("div", "config-bar");

const banner = el("div", "banner banner-hidden");

const body = el("div", "body");
const sessionList = el("div", "session-list");
const sessionListHeader = el("div", "session-list-header");
const sessionListTitle = el("span", undefined, "Sessions");
const newSessionButton = el("button", "new-session-btn", "+ New");
sessionListHeader.append(sessionListTitle, newSessionButton);
const sessionListItems = el("div", "session-list-items");
sessionList.append(sessionListHeader, sessionListItems);

const chatPane = el("div", "chat-pane");
const chatLog = el("div", "chat-log");
const inputBar = el("div", "input-bar");
const promptInput = el("textarea", "prompt-input");
promptInput.placeholder = "Message Claude…";
promptInput.rows = 2;
const sendButton = el("button", "send-btn", "Send");
inputBar.append(promptInput, sendButton);
chatPane.append(chatLog, inputBar);

body.append(sessionList, chatPane);
root.append(topBar, configBar, banner, body);

profileSelect.addEventListener("change", () =>
  post({ type: "selectProfile", profile: profileSelect.value }),
);
newSessionButton.addEventListener("click", () => {
  state.currentSessionId = undefined;
  clearChat();
  appendSystemNote("Starting new session…");
  post({ type: "newSession" });
});

function sendCurrentPrompt(): void {
  const text = promptInput.value.trim();
  if (!text || state.busy || !state.currentSessionId) {
    return;
  }
  promptInput.value = "";
  appendMessageBubble("user", text);
  setBusy(true);
  post({ type: "sendPrompt", text });
}

sendButton.addEventListener("click", () => {
  if (state.busy) {
    post({ type: "cancelPrompt" });
    return;
  }
  sendCurrentPrompt();
});
promptInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendCurrentPrompt();
  }
});

function setBusy(busy: boolean): void {
  state.busy = busy;
  sendButton.textContent = busy ? "Cancel" : "Send";
  promptInput.disabled = busy;
}

function setStatus(): void {
  statusDot.className = `status-dot status-${state.connection}`;
  statusDot.title = state.connection;
  const disabled = state.connection !== "connected" || !state.currentSessionId;
  sendButton.disabled = disabled && !state.busy;
  promptInput.disabled = state.connection !== "connected";
}

function showBanner(message: string): void {
  banner.textContent = message;
  banner.className = "banner";
}

function clearChat(): void {
  chatLog.replaceChildren();
  state.toolCards.clear();
  state.lastMessageBubble = undefined;
}

function appendSystemNote(text: string): void {
  chatLog.append(el("div", "system-note", text));
  state.lastMessageBubble = undefined;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function textOf(block: ContentBlock): string {
  if (block.type === "text") {
    return block.text;
  }
  return `[${block.type}]`;
}

function appendMessageBubble(role: string, text: string): HTMLElement {
  if (state.lastMessageBubble?.role === role) {
    state.lastMessageBubble.el.textContent += text;
    chatLog.scrollTop = chatLog.scrollHeight;
    return state.lastMessageBubble.el;
  }
  const bubble = el("div", `bubble bubble-${role}`, text);
  chatLog.append(bubble);
  state.lastMessageBubble = { role, el: bubble };
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

function appendThoughtChunk(text: string): void {
  if (state.lastMessageBubble?.role === "thought") {
    state.lastMessageBubble.el.textContent += text;
    return;
  }
  const bubble = el("div", "bubble bubble-thought", text);
  chatLog.append(bubble);
  state.lastMessageBubble = { role: "thought", el: bubble };
  chatLog.scrollTop = chatLog.scrollHeight;
}

function toolCardFor(toolCallId: string, title: string): ToolCardHandle {
  let card = state.toolCards.get(toolCallId);
  if (card) {
    return card;
  }
  const rootEl = el("div", "tool-card");
  const header = el("div", "tool-card-header");
  const titleEl = el("span", "tool-card-title", title);
  const statusEl = el("span", "tool-card-status");
  header.append(titleEl, statusEl);
  const bodyEl = el("div", "tool-card-body");
  rootEl.append(header, bodyEl);
  chatLog.append(rootEl);
  card = { root: rootEl, title: titleEl, status: statusEl, body: bodyEl };
  state.toolCards.set(toolCallId, card);
  state.lastMessageBubble = undefined;
  chatLog.scrollTop = chatLog.scrollHeight;
  return card;
}

function renderToolCallContent(
  card: ToolCardHandle,
  update: ToolCallUpdate | { content?: ToolCallUpdate["content"] },
): void {
  if (!update.content) {
    return;
  }
  card.body.replaceChildren();
  for (const item of update.content) {
    if (item.type === "content") {
      card.body.append(el("pre", "tool-content-text", textOf(item.content)));
    } else if (item.type === "diff") {
      const details = el("details", "tool-diff");
      details.append(el("summary", undefined, item.path));
      if (item.oldText) {
        details.append(el("pre", "diff-old", item.oldText));
      }
      details.append(el("pre", "diff-new", item.newText));
      card.body.append(details);
    } else {
      card.body.append(el("div", "tool-content-other", "[terminal output]"));
    }
  }
}

function applyToolCall(
  update: SessionUpdate & { sessionUpdate: "tool_call" },
): void {
  const card = toolCardFor(update.toolCallId, update.title);
  card.status.textContent = update.status ?? "pending";
  renderToolCallContent(card, update);
}

function applyToolCallUpdate(
  update: SessionUpdate & { sessionUpdate: "tool_call_update" },
): void {
  const card = toolCardFor(update.toolCallId, update.title ?? "Tool call");
  if (update.title) {
    card.title.textContent = update.title;
  }
  if (update.status) {
    card.status.textContent = update.status;
  }
  renderToolCallContent(card, update);
}

function applyPlan(update: SessionUpdate & { sessionUpdate: "plan" }): void {
  const planEl = el("div", "plan-card");
  planEl.append(el("div", "plan-title", "Plan"));
  for (const entry of update.entries) {
    planEl.append(
      el(
        "div",
        `plan-entry plan-${entry.status}`,
        `${entry.status === "completed" ? "✓" : "•"} ${entry.content}`,
      ),
    );
  }
  chatLog.append(planEl);
  state.lastMessageBubble = undefined;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderConfigOptions(): void {
  configBar.replaceChildren();
  for (const option of state.configOptions) {
    const wrap = el("label", "config-option");
    wrap.append(el("span", "config-option-label", option.name));
    if (option.type === "boolean") {
      const input = el("input", "config-option-checkbox");
      input.type = "checkbox";
      input.checked = option.currentValue;
      input.addEventListener("change", () =>
        post({
          type: "setConfigOption",
          configId: option.id,
          value: input.checked,
        }),
      );
      wrap.append(input);
    } else {
      const select = el("select", "config-option-select");
      for (const opt of option.options) {
        if ("group" in opt) {
          const group = el("optgroup") as HTMLOptGroupElement;
          group.label = opt.name;
          for (const sub of opt.options) {
            const entry = el("option") as HTMLOptionElement;
            entry.value = sub.value;
            entry.textContent = sub.name;
            group.append(entry);
          }
          select.append(group);
        } else {
          const entry = el("option") as HTMLOptionElement;
          entry.value = opt.value;
          entry.textContent = opt.name;
          select.append(entry);
        }
      }
      select.value = option.currentValue;
      select.addEventListener("change", () =>
        post({
          type: "setConfigOption",
          configId: option.id,
          value: select.value,
        }),
      );
      wrap.append(select);
    }
    configBar.append(wrap);
  }
}

function renderPermissionRequest(
  requestId: string,
  sessionId: SessionId,
  toolCall: ToolCallUpdate,
  options: PermissionOption[],
): void {
  const card = el("div", "permission-card");
  card.dataset.requestId = requestId;
  card.append(
    el("div", "permission-title", toolCall.title ?? "Permission requested"),
  );
  const buttons = el("div", "permission-buttons");
  for (const option of options) {
    const button = el(
      "button",
      `permission-btn permission-${option.kind}`,
      option.name,
    );
    button.addEventListener("click", () => {
      post({
        type: "permissionResponse",
        requestId,
        optionId: option.optionId,
      });
      buttons.querySelectorAll("button").forEach(b => (b.disabled = true));
      card.classList.add("permission-resolved");
    });
    buttons.append(button);
  }
  card.append(buttons);
  chatLog.append(card);
  state.lastMessageBubble = undefined;
  chatLog.scrollTop = chatLog.scrollHeight;
  void sessionId;
}

function renderSessions(): void {
  sessionListItems.replaceChildren();
  for (const session of state.sessions) {
    const item = el("div", "session-item", session.title || session.sessionId);
    if (session.sessionId === state.currentSessionId) {
      item.classList.add("session-item-active");
    }
    item.addEventListener("click", () => {
      state.currentSessionId = session.sessionId;
      clearChat();
      renderSessions();
      setStatus();
      post({ type: "selectSession", sessionId: session.sessionId });
    });
    sessionListItems.append(item);
  }
}

function handleSessionUpdate(
  sessionId: SessionId,
  update: SessionUpdate,
): void {
  if (sessionId !== state.currentSessionId) {
    return;
  }
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      appendMessageBubble("user", textOf(update.content));
      break;
    case "agent_message_chunk":
      appendMessageBubble("agent", textOf(update.content));
      break;
    case "agent_thought_chunk":
      appendThoughtChunk(textOf(update.content));
      break;
    case "tool_call":
      applyToolCall(update);
      break;
    case "tool_call_update":
      applyToolCallUpdate(update);
      break;
    case "plan":
      applyPlan(update);
      break;
    case "config_option_update":
      state.configOptions = update.configOptions;
      renderConfigOptions();
      break;
    default:
      break;
  }
}

window.addEventListener(
  "message",
  (event: MessageEvent<HostToWebviewMessage>) => {
    const message = event.data;
    switch (message.type) {
      case "profiles": {
        state.profiles = message.profiles;
        state.currentProfile = message.current;
        profileSelect.replaceChildren(
          ...message.profiles.map(p => {
            const opt = el("option") as HTMLOptionElement;
            opt.value = p.name;
            opt.textContent = p.name;
            return opt;
          }),
        );
        profileSelect.value = message.current;
        break;
      }
      case "connectionState": {
        state.connection = message.state;
        setStatus();
        if (message.state === "error") {
          showBanner(message.error ?? "Connection error");
        } else if (message.state === "connected") {
          banner.className = "banner banner-hidden";
        }
        break;
      }
      case "sessions": {
        state.sessions = message.sessions;
        renderSessions();
        break;
      }
      case "sessionStarted": {
        state.currentSessionId = message.sessionId;
        state.configOptions = message.configOptions ?? [];
        renderConfigOptions();
        renderSessions();
        setStatus();
        if (!state.sessions.some(s => s.sessionId === message.sessionId)) {
          post({ type: "listSessions" });
        }
        break;
      }
      case "sessionUpdate": {
        handleSessionUpdate(message.sessionId, message.update);
        break;
      }
      case "permissionRequest": {
        renderPermissionRequest(
          message.requestId,
          message.sessionId,
          message.toolCall,
          message.options,
        );
        break;
      }
      case "permissionResolved": {
        const card = chatLog.querySelector<HTMLElement>(
          `.permission-card[data-request-id="${message.requestId}"]`,
        );
        card?.classList.add("permission-resolved");
        card?.querySelectorAll("button").forEach(b => (b.disabled = true));
        break;
      }
      case "promptStopped": {
        if (message.sessionId === state.currentSessionId) {
          setBusy(false);
        }
        break;
      }
      case "error": {
        showBanner(message.message);
        setBusy(false);
        break;
      }
    }
  },
);

setStatus();
post({ type: "ready" });
