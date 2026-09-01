// DOM rendering shared by the interactive chat webview (src/webview/main.ts,
// currently dormant) and the read-only session viewer (src/webview/sessionView.ts).
// Browser-side only — no vscode-specific imports.

import type {
  ContentBlock,
  SessionUpdate,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import hljs from "highlight.js";
import { marked } from "marked";

marked.setOptions({ breaks: true });

export function el<K extends keyof HTMLElementTagNameMap>(
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

export function textOf(block: ContentBlock): string {
  if (block.type === "text") {
    return block.text;
  }
  return `[${block.type}]`;
}

// Shown as a fixed prefix on every tool-call card regardless of what title
// text the agent sends — some agents (e.g. web search) replace their title
// with just the query once known, dropping the tool name entirely otherwise.
const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch Mode",
  other: "Tool",
};

const BARE_URL_RE = /https?:\/\/[^\s<>"']+/g;
// Trailing punctuation is almost always sentence punctuation, not part of the URL.
const URL_TRAILING_PUNCTUATION_RE = /[).,;:!?\]}'"]+$/;

/** Turns bare `https://...` URLs in plain text into clickable links via DOM
 *  APIs (no HTML string building) — used for user messages, which otherwise
 *  render as plain `textContent` so literal markdown-looking characters in a
 *  prompt never get reinterpreted as formatting. */
function linkify(container: HTMLElement, text: string): void {
  container.replaceChildren();
  let lastIndex = 0;
  for (const match of text.matchAll(BARE_URL_RE)) {
    let url = match[0];
    const trailing = url.match(URL_TRAILING_PUNCTUATION_RE)?.[0] ?? "";
    url = url.slice(0, url.length - trailing.length);
    if (!url) {
      continue;
    }
    container.append(
      document.createTextNode(text.slice(lastIndex, match.index)),
    );
    const link = el("a", undefined, url);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    container.append(link);
    lastIndex = match.index + url.length;
  }
  container.append(document.createTextNode(text.slice(lastIndex)));
}

// Static, trusted markup (not derived from any agent/user data) — safe to
// assign via innerHTML.
const COPY_ICON_SVG = `<svg class="icon-copy" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5V3a1 1 0 0 1 1-1H11"/></svg>`;
const CHECK_ICON_SVG = `<svg class="icon-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>`;

/** Wraps a rendered fenced code block with a hover-revealed copy button,
 *  matching the native chat view's code-block toolbar (minus run/insert,
 *  which need editor access this read-only viewer doesn't have). */
function addCopyButton(pre: HTMLPreElement): void {
  const wrapper = el("div", "code-block");
  pre.replaceWith(wrapper);
  wrapper.append(pre);
  const button = el("button", "code-copy-btn");
  button.type = "button";
  button.setAttribute("aria-label", "Copy code");
  button.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(pre.textContent ?? "").then(() => {
      button.classList.add("copied");
      setTimeout(() => {
        button.classList.remove("copied");
      }, 1200);
    });
  });
  wrapper.append(button);
}

interface ToolCardHandle {
  root: HTMLElement;
  kindLabel: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
}

function renderToolCallContent(
  card: ToolCardHandle,
  update: { content?: ToolCallUpdate["content"] },
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

/** Renders a stream of `SessionUpdate`s into a container as a linear
 *  transcript: user/agent message bubbles (consecutive chunks of the same
 *  role merge into one bubble) and tool-call cards.
 *
 *  Intentionally unhandled for now (received updates are silently dropped —
 *  nothing here mutates state that would need them): `plan`/`plan_update`/
 *  `plan_removed`, `available_commands_update`, `current_mode_update`,
 *  `config_option_update`, `usage_update`, `session_info_update`. */
export class TranscriptRenderer {
  private readonly container: HTMLElement;
  private readonly toolCards = new Map<string, ToolCardHandle>();
  private lastBubble:
    { role: string; el: HTMLElement; text: string } | undefined;
  private loadingNote: HTMLElement | undefined;
  private turnChain:
    | {
        details: HTMLDetailsElement | undefined;
        countEl: HTMLElement | undefined;
        body: HTMLElement | undefined;
        startedAt: number;
        count: number;
        lastMount: HTMLElement;
      }
    | undefined;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  clear(): void {
    this.container.replaceChildren();
    this.toolCards.clear();
    this.lastBubble = undefined;
    this.loadingNote = undefined;
    this.turnChain = undefined;
  }

  appendSystemNote(text: string): void {
    this.turnChain = undefined;
    this.container.append(el("div", "system-note", text));
    this.lastBubble = undefined;
    this.scrollToEnd();
  }

  /** Same as `appendSystemNote`, but remembered so the next real transcript
   *  content (`applyUpdate`) removes it automatically — used for the
   *  transient "Loading…" placeholder, which otherwise lingers at the top
   *  of the transcript once replay actually starts arriving. */
  appendLoadingNote(text: string): void {
    this.loadingNote?.remove();
    this.loadingNote = el("div", "system-note", text);
    this.container.append(this.loadingNote);
    this.lastBubble = undefined;
    this.turnChain = undefined;
    this.scrollToEnd();
  }

  /** Same as `appendSystemNote`, but styled to stand out as an actual
   *  failure (e.g. a session that failed to load) rather than a transient
   *  status line like "Loading…". */
  appendErrorNote(text: string): void {
    this.container.append(el("div", "system-note-error", text));
    this.lastBubble = undefined;
    this.turnChain = undefined;
    this.scrollToEnd();
  }

  applyUpdate(update: SessionUpdate): void {
    if (this.loadingNote) {
      this.loadingNote.remove();
      this.loadingNote = undefined;
    }
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        this.appendBubble("user", textOf(update.content));
        break;
      case "agent_message_chunk":
        this.appendBubble("agent", textOf(update.content));
        break;
      case "agent_thought_chunk":
        this.appendBubble("thought", textOf(update.content));
        break;
      case "tool_call":
        this.applyToolCall(update);
        break;
      case "tool_call_update":
        this.applyToolCallUpdate(update);
        break;
      default:
        // See class doc comment — not rendered yet.
        break;
    }
  }

  /** Everything the agent produces (text, tool calls, reasoning) between two
   *  user messages is one logical turn. Matches VS Code's own chat view: only
   *  the most recent item of the turn stays visible at the top level: every
   *  earlier item gets folded into a collapsible "Completed N steps in
   *  Ys" wrapper as soon as it's superseded. Since we don't know an item is
   *  "not last" until the next one arrives, folding happens retroactively —
   *  each call moves the previous last item into the wrapper (creating it
   *  lazily on the second item) before making `mount` the new last item. A
   *  user message (see `appendBubble`) or a system note ends the turn,
   *  leaving whatever's currently visible as the permanent final state. */
  private presentTurnItem(mount: HTMLElement): void {
    const chain = this.turnChain;
    if (!chain) {
      this.turnChain = {
        details: undefined,
        countEl: undefined,
        body: undefined,
        startedAt: Date.now(),
        count: 0,
        lastMount: mount,
      };
      this.container.append(mount);
      return;
    }
    if (!chain.details) {
      const details = el("details", "tool-card tool-chain");
      const summary = el("summary", "tool-card-header");
      const countEl = el("span", "tool-card-title");
      summary.append(countEl);
      const body = el("div", "tool-chain-body");
      details.append(summary, body);
      this.container.insertBefore(details, chain.lastMount);
      chain.details = details;
      chain.countEl = countEl;
      chain.body = body;
    }
    chain.body!.append(chain.lastMount);
    chain.count += 1;
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - chain.startedAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    const duration = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    chain.countEl!.textContent = `Completed ${chain.count} step${chain.count === 1 ? "" : "s"} in ${duration}`;
    this.container.append(mount);
    chain.lastMount = mount;
  }

  private appendBubble(role: string, text: string): void {
    if (this.lastBubble?.role === role) {
      this.lastBubble.text += text;
      this.renderBubble(this.lastBubble);
      this.scrollToEnd();
      return;
    }
    let mount: HTMLElement;
    let content: HTMLElement;
    if (role === "thought") {
      // Collapsed by default, like a tool call — reasoning is supplementary,
      // not the primary reply, and can get long.
      const details = el("details", "tool-card thought-card");
      const summary = el("summary", "tool-card-header", "Thought");
      const body = el("div", "bubble bubble-thought");
      details.append(summary, body);
      mount = details;
      content = body;
      this.presentTurnItem(mount);
    } else if (role === "user") {
      // Ends the turn — the user bubble itself is never foldable, and
      // whatever was last in the agent's turn stays visible for good.
      const bubble = el("div", `bubble bubble-${role}`);
      mount = bubble;
      content = bubble;
      this.turnChain = undefined;
      this.container.append(mount);
    } else {
      const bubble = el("div", `bubble bubble-${role}`);
      mount = bubble;
      content = bubble;
      this.presentTurnItem(mount);
    }
    this.lastBubble = { role, el: content, text };
    this.renderBubble(this.lastBubble);
    this.scrollToEnd();
  }

  /** Agent/thought text is markdown; user text is rendered verbatim so
   *  literal prompt text (which may itself contain `#`/`*`/backticks etc.)
   *  never gets reinterpreted as formatting. Re-parses the full accumulated
   *  text on every chunk rather than appending incrementally, since a
   *  streamed chunk boundary can land mid-markdown-construct (e.g. inside a
   *  ```` ``` ```` fence). Safe against injected HTML because the page's CSP
   *  has no `unsafe-inline` in `script-src`, so any `<script>`/`onerror=`
   *  markup `marked` emits is inert. */
  private renderBubble(bubble: {
    role: string;
    el: HTMLElement;
    text: string;
  }): void {
    if (bubble.role === "user") {
      linkify(bubble.el, bubble.text);
      return;
    }
    bubble.el.innerHTML = marked.parse(bubble.text, { async: false });
    for (const codeEl of bubble.el.querySelectorAll<HTMLElement>("pre code")) {
      hljs.highlightElement(codeEl);
    }
    for (const pre of bubble.el.querySelectorAll<HTMLPreElement>("pre")) {
      addCopyButton(pre);
    }
  }

  private toolCardFor(
    toolCallId: string,
    title: string,
    kind?: ToolKind | null,
  ): ToolCardHandle {
    let card = this.toolCards.get(toolCallId);
    if (card) {
      return card;
    }
    // <details>/<summary> so each call is collapsed by default (matches
    // VS Code's own chat view) — the browser handles show/hide on click,
    // no extra state or listeners needed here.
    const root = el("details", "tool-card");
    const header = el("summary", "tool-card-header");
    const kindLabelEl = el(
      "span",
      "tool-card-kind",
      TOOL_KIND_LABELS[kind ?? "other"],
    );
    const titleEl = el("span", "tool-card-title", title);
    const statusEl = el("span", "tool-card-status");
    header.append(kindLabelEl, titleEl, statusEl);
    const body = el("div", "tool-card-body");
    root.append(header, body);
    this.presentTurnItem(root);
    card = {
      root,
      kindLabel: kindLabelEl,
      title: titleEl,
      status: statusEl,
      body,
    };
    this.toolCards.set(toolCallId, card);
    this.lastBubble = undefined;
    this.scrollToEnd();
    return card;
  }

  private applyToolCall(
    update: SessionUpdate & { sessionUpdate: "tool_call" },
  ): void {
    const card = this.toolCardFor(update.toolCallId, update.title, update.kind);
    card.status.textContent = update.status ?? "pending";
    renderToolCallContent(card, update);
  }

  private applyToolCallUpdate(
    update: SessionUpdate & { sessionUpdate: "tool_call_update" },
  ): void {
    const card = this.toolCardFor(
      update.toolCallId,
      update.title ?? "Tool call",
      update.kind,
    );
    if (update.title) {
      card.title.textContent = update.title;
    }
    if (update.kind) {
      card.kindLabel.textContent = TOOL_KIND_LABELS[update.kind];
    }
    if (update.status) {
      card.status.textContent = update.status;
    }
    renderToolCallContent(card, update);
  }

  private scrollToEnd(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
