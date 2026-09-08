// Session transcript rendering: a pure reducer (ACP updates -> immutable
// block list) plus Preact/htm components that render that list. Everything
// the agent produces (text, tool calls, reasoning, permission requests)
// between two user messages is one "turn" — matches VS Code's own chat view,
// only the most recent item of a turn stays visible at the top level; every
// earlier item is folded into a collapsible "Completed N steps in Ys"
// wrapper. Browser-side only — no vscode (extension host) imports.

import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  SessionId,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import hljs from "highlight.js";
import { html } from "htm/preact";
import { marked } from "marked";
import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionViewMeta } from "../shared/sessionViewProtocol.ts";

marked.setOptions({ breaks: true });

function textOf(block: ContentBlock): string {
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

// Some agents already fold the verb into the title (e.g. edit calls titled
// "Edit package.json"); others don't (e.g. web search titled with just the
// query). Only show the separate kind-label span when the title doesn't
// already start with it, to avoid "Edit Edit package.json".
function showsOwnKindLabel(kind: ToolKind, title: string): boolean {
  return title.toLowerCase().startsWith(TOOL_KIND_LABELS[kind].toLowerCase());
}

// ---------------------------------------------------------------------------
// State

interface TextItem {
  type: "text";
  id: string;
  role: "agent" | "thought";
  text: string;
}

interface ToolItem {
  type: "tool";
  id: string;
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: string;
  content: ToolCallUpdate["content"];
}

interface PermissionItem {
  type: "permission";
  id: string;
  requestId: string;
  title: string;
  kind: ToolKind;
  options: PermissionOption[];
  // undefined = pending, null = resolved without knowing which option (e.g.
  // the request was aborted host-side), string = the clicked option's id.
  resolvedOptionId: string | null | undefined;
}

type TurnItem = TextItem | ToolItem | PermissionItem;

interface TurnBlock {
  type: "turn";
  id: string;
  items: TurnItem[];
}

interface NoteBlock {
  type: "note";
  id: string;
  kind: "info" | "error";
  text: string;
  // Offers a "Fork session" button — set when this error was the session
  // being currently owned by a live background-agent process elsewhere.
  forkable?: boolean;
}

interface UserBlock {
  type: "user";
  id: string;
  text: string;
}

type Block = NoteBlock | UserBlock | TurnBlock;

export interface ViewState {
  meta: SessionViewMeta | undefined;
  blocks: Block[];
  busy: boolean;
  loading: boolean;
  // Text currently typed in the composer, plus every other session's typed
  // text this webview has seen — swapped in/out on session switch so a draft
  // never lingers to be sent to the wrong session, and isn't lost either.
  draftText: string;
  drafts: Map<SessionId, string>;
  // Replaces the plain "Working…" note while set — e.g. "Retrying Claude,
  // attempt 2 of 10." from the AIR session-failure extension. Cleared once
  // real content resumes (it's stale by then) or the turn ends.
  statusText: string | undefined;
  // Slash commands the agent advertised for this session, for the
  // composer's completion popup. Empty until the agent sends one.
  availableCommands: AvailableCommand[];
}

export const initialState: ViewState = {
  meta: undefined,
  blocks: [],
  busy: false,
  loading: false,
  draftText: "",
  drafts: new Map(),
  statusText: undefined,
  availableCommands: [],
};

export type Action =
  | { type: "loading"; meta: SessionViewMeta }
  | { type: "sessionUpdate"; sessionId: SessionId; update: SessionUpdate }
  | {
      type: "replayBatch";
      sessionId: SessionId;
      updates: SessionUpdate[];
      busy: boolean;
    }
  | { type: "error"; text: string; forkable?: boolean }
  | { type: "sendStart" }
  | { type: "promptStopped"; sessionId: SessionId; stopReason: StopReason }
  | { type: "draftSent" }
  | {
      type: "permissionRequest";
      requestId: string;
      sessionId: SessionId;
      toolCall: ToolCallUpdate;
      options: PermissionOption[];
    }
  | { type: "localPermissionResponse"; requestId: string; optionId: string }
  | { type: "permissionResolved"; requestId: string }
  | { type: "draftChanged"; text: string }
  | { type: "closed" };

let idCounter = 0;
function genId(): string {
  idCounter += 1;
  return `b${idCounter}`;
}

function lastBlock(blocks: Block[]): Block | undefined {
  return blocks[blocks.length - 1];
}

function pushToTurn(blocks: Block[], item: TurnItem): Block[] {
  const last = lastBlock(blocks);
  if (last?.type === "turn") {
    const turn: TurnBlock = { ...last, items: [...last.items, item] };
    return [...blocks.slice(0, -1), turn];
  }
  return [...blocks, { type: "turn", id: genId(), items: [item] }];
}

function replaceLastTurnItem(
  blocks: Block[],
  updater: (item: TurnItem) => TurnItem,
): Block[] {
  const last = lastBlock(blocks);
  if (last?.type !== "turn") {
    return blocks;
  }
  const items = last.items.slice();
  items[items.length - 1] = updater(items[items.length - 1]);
  return [...blocks.slice(0, -1), { ...last, items }];
}

function updateTurnItem(
  blocks: Block[],
  predicate: (item: TurnItem) => boolean,
  updater: (item: TurnItem) => TurnItem,
): Block[] {
  return blocks.map(block => {
    if (block.type !== "turn") {
      return block;
    }
    let changed = false;
    const items = block.items.map(item => {
      if (predicate(item)) {
        changed = true;
        return updater(item);
      }
      return item;
    });
    return changed ? { ...block, items } : block;
  });
}

function appendUserChunk(blocks: Block[], text: string): Block[] {
  const last = lastBlock(blocks);
  if (last?.type === "user") {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...blocks, { type: "user", id: genId(), text }];
}

function appendText(
  blocks: Block[],
  role: "agent" | "thought",
  text: string,
): Block[] {
  const last = lastBlock(blocks);
  if (last?.type === "turn") {
    const lastItem = last.items[last.items.length - 1];
    if (lastItem?.type === "text" && lastItem.role === role) {
      return replaceLastTurnItem(blocks, item => ({
        ...(item as TextItem),
        text: (item as TextItem).text + text,
      }));
    }
  }
  return pushToTurn(blocks, { type: "text", id: genId(), role, text });
}

function upsertToolCall(
  blocks: Block[],
  update: {
    toolCallId: string;
    title?: string | null;
    kind?: ToolKind | null;
    status?: string | null;
    content?: ToolCallUpdate["content"];
  },
): Block[] {
  const exists = blocks.some(
    block =>
      block.type === "turn" &&
      block.items.some(
        item => item.type === "tool" && item.toolCallId === update.toolCallId,
      ),
  );
  if (exists) {
    return updateTurnItem(
      blocks,
      item => item.type === "tool" && item.toolCallId === update.toolCallId,
      item => {
        const tool = item as ToolItem;
        return {
          ...tool,
          title: update.title ?? tool.title,
          kind: update.kind ?? tool.kind,
          status: update.status ?? tool.status,
          content: update.content ?? tool.content,
        };
      },
    );
  }
  return pushToTurn(blocks, {
    type: "tool",
    id: genId(),
    toolCallId: update.toolCallId,
    title: update.title ?? "Tool call",
    kind: update.kind ?? "other",
    status: update.status ?? "pending",
    content: update.content,
  });
}

function applySessionUpdate(blocks: Block[], update: SessionUpdate): Block[] {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendUserChunk(blocks, textOf(update.content));
    case "agent_message_chunk":
      return appendText(blocks, "agent", textOf(update.content));
    case "agent_thought_chunk":
      return appendText(blocks, "thought", textOf(update.content));
    case "tool_call":
    case "tool_call_update":
      return upsertToolCall(blocks, update);
    default:
      // plan/plan_update/available_commands_update/current_mode_update/
      // config_option_update/usage_update/session_info_update — not
      // rendered yet, no-op.
      return blocks;
  }
}

function readNested(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** `session_info_update` is also (unrelatedly) how the bridge announces a
 *  session's auto-generated title — only pull out the AIR extension's
 *  connection/retry status, which lives under a specific `_meta` path (see
 *  `sessionFailureMeta` in the bridge's `session-failure-extension.js`). Only
 *  surfaced at all because AgentClient declares the `jetbrains.air` client
 *  capability at `initialize` — without it the bridge never sends these. */
function extractSessionFailureTitle(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== "session_info_update") {
    return undefined;
  }
  const title = readNested(
    update._meta,
    "jetbrains",
    "air",
    "sessionFailure",
    "title",
  );
  return typeof title === "string" ? title : undefined;
}

function extractAvailableCommands(
  update: SessionUpdate,
): AvailableCommand[] | undefined {
  return update.sessionUpdate === "available_commands_update"
    ? update.availableCommands
    : undefined;
}

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case "loading": {
      const drafts = new Map(state.drafts);
      if (state.meta) {
        if (state.draftText) {
          drafts.set(state.meta.sessionId, state.draftText);
        } else {
          drafts.delete(state.meta.sessionId);
        }
      }
      return {
        meta: action.meta,
        blocks: [],
        busy: false,
        loading: true,
        draftText: drafts.get(action.meta.sessionId) ?? "",
        drafts,
        statusText: undefined,
        availableCommands: [],
      };
    }
    case "error":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            type: "note",
            id: genId(),
            kind: "error",
            text: action.text,
            forkable: action.forkable,
          },
        ],
        busy: false,
        loading: false,
        statusText: undefined,
      };
    case "sendStart":
      return { ...state, busy: true, statusText: undefined };
    case "promptStopped":
      return action.sessionId === state.meta?.sessionId
        ? { ...state, busy: false, statusText: undefined }
        : state;
    // The user bubble itself now always arrives through "sessionUpdate" (see
    // AgentClient.echoUserMessage) so every view showing this session gets
    // it, not just whichever one sent it — this action only clears the
    // composer, dispatched locally for instant feedback on click.
    case "draftSent": {
      const drafts = new Map(state.drafts);
      if (state.meta) {
        drafts.delete(state.meta.sessionId);
      }
      return { ...state, draftText: "", drafts };
    }
    case "draftChanged":
      return { ...state, draftText: action.text };
    case "sessionUpdate": {
      if (action.sessionId !== state.meta?.sessionId) {
        return state;
      }
      const blocks = applySessionUpdate(state.blocks, action.update);
      const failureTitle = extractSessionFailureTitle(action.update);
      const commands = extractAvailableCommands(action.update);
      return {
        ...state,
        blocks,
        loading: false,
        statusText:
          failureTitle ??
          (blocks !== state.blocks ? undefined : state.statusText),
        availableCommands: commands ?? state.availableCommands,
      };
    }
    case "replayBatch": {
      if (action.sessionId !== state.meta?.sessionId) {
        return state;
      }
      let blocks = state.blocks;
      let statusText = state.statusText;
      let availableCommands = state.availableCommands;
      for (const update of action.updates) {
        const before = blocks;
        blocks = applySessionUpdate(blocks, update);
        const failureTitle = extractSessionFailureTitle(update);
        if (failureTitle !== undefined) {
          statusText = failureTitle;
        } else if (blocks !== before) {
          statusText = undefined;
        }
        availableCommands =
          extractAvailableCommands(update) ?? availableCommands;
      }
      return {
        ...state,
        availableCommands,
        blocks,
        loading: false,
        busy: action.busy,
        statusText,
      };
    }
    case "permissionRequest": {
      if (action.sessionId !== state.meta?.sessionId) {
        return state;
      }
      const item: PermissionItem = {
        type: "permission",
        id: genId(),
        requestId: action.requestId,
        title: action.toolCall.title ?? "Permission requested",
        kind: action.toolCall.kind ?? "other",
        options: action.options,
        resolvedOptionId: undefined,
      };
      return {
        ...state,
        blocks: pushToTurn(state.blocks, item),
        loading: false,
      };
    }
    case "localPermissionResponse":
      return {
        ...state,
        blocks: updateTurnItem(
          state.blocks,
          item =>
            item.type === "permission" && item.requestId === action.requestId,
          item => ({
            ...(item as PermissionItem),
            resolvedOptionId: action.optionId,
          }),
        ),
      };
    case "permissionResolved":
      return {
        ...state,
        blocks: updateTurnItem(
          state.blocks,
          item =>
            item.type === "permission" &&
            item.requestId === action.requestId &&
            item.resolvedOptionId === undefined,
          item => ({ ...(item as PermissionItem), resolvedOptionId: null }),
        ),
      };
    case "closed":
      return { ...initialState, drafts: new Map() };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Rendering

const BARE_URL_RE = /https?:\/\/[^\s<>"']+/g;
// Trailing punctuation is almost always sentence punctuation, not part of the URL.
const URL_TRAILING_PUNCTUATION_RE = /[).,;:!?\]}'"]+$/;

/** Turns bare `https://...` URLs in plain text into clickable links — used
 *  for user messages, which otherwise render as plain text so literal
 *  markdown-looking characters in a prompt never get reinterpreted as
 *  formatting. */
function linkify(text: string): (string | ReturnType<typeof html>)[] {
  const parts: (string | ReturnType<typeof html>)[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(BARE_URL_RE)) {
    let url = match[0];
    const trailing = url.match(URL_TRAILING_PUNCTUATION_RE)?.[0] ?? "";
    url = url.slice(0, url.length - trailing.length);
    if (!url) {
      continue;
    }
    parts.push(text.slice(lastIndex, match.index));
    parts.push(
      html`<a href=${url} target="_blank" rel="noopener noreferrer">${url}</a>`,
    );
    lastIndex = match.index + url.length;
  }
  parts.push(text.slice(lastIndex));
  return parts;
}

// Static, trusted markup (not derived from any agent/user data) — safe to
// assign via innerHTML.
const COPY_ICON_SVG = `<svg class="icon-copy" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5V3a1 1 0 0 1 1-1H11"/></svg>`;
const CHECK_ICON_SVG = `<svg class="icon-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>`;

/** Wraps a rendered fenced code block with a hover-revealed copy button,
 *  matching the native chat view's code-block toolbar (minus run/insert,
 *  which need editor access this read-only viewer doesn't have). */
function addCopyButton(pre: HTMLPreElement): void {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block";
  pre.replaceWith(wrapper);
  wrapper.append(pre);
  const button = document.createElement("button");
  button.className = "code-copy-btn";
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

/** Agent/thought text is markdown; re-parses the full accumulated text on
 *  every chunk rather than appending incrementally, since a streamed chunk
 *  boundary can land mid-markdown-construct (e.g. inside a ```` ``` ````
 *  fence). Safe against injected HTML because the page's CSP has no
 *  `unsafe-inline` in `script-src`, so any `<script>`/`onerror=` markup
 *  `marked` emits is inert. hljs/copy-button setup runs as a DOM side effect
 *  after each render since it must mutate real nodes the innerHTML produced,
 *  which Preact's diffing doesn't reach into. */
// Debugging aid: JSON.stringify the underlying data behind a block/item into
// its `title` attribute, so hovering it shows the raw update(s) that produced
// it as a native tooltip. Cheap, zero extra UI, easy to strip out later.
function debugTitle(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function MarkdownBody({
  text,
  class: className,
  debug,
}: {
  text: string;
  class: string;
  debug?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rendered = marked.parse(text, { async: false }) as string;
  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    for (const codeEl of node.querySelectorAll<HTMLElement>("pre code")) {
      hljs.highlightElement(codeEl);
    }
    for (const pre of node.querySelectorAll<HTMLPreElement>("pre")) {
      addCopyButton(pre);
    }
  }, [rendered]);
  return html`<div
    class=${className}
    ref=${ref}
    title=${debug !== undefined ? debugTitle(debug) : undefined}
    dangerouslySetInnerHTML=${{ __html: rendered }}
  ></div>`;
}

/** `<details>` has no reactive "open" prop — it's a one-time initial value,
 *  set imperatively so a later re-render (e.g. the status text updating)
 *  doesn't fight a user who's manually collapsed it back. Used to default
 *  the currently in-progress step of a live turn open, so there's visible
 *  progress instead of every step looking collapsed the instant it appears. */
function useOpenOnMount(defaultOpen: boolean | undefined) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (defaultOpen && ref.current) {
      ref.current.open = true;
    }
  }, []);
  return ref;
}

// Full tool output (a whole file's contents, a long command's stdout) can run
// to tens of thousands of characters — collapse past this length by default
// with a "Show more" toggle, same idea as the tool card itself being collapsed.
const TOOL_CONTENT_TRUNCATE_LENGTH = 2000;

function TruncatedPre({
  text,
  class: className,
}: {
  text: string;
  class: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > TOOL_CONTENT_TRUNCATE_LENGTH;
  const shown =
    expanded || !isLong ? text : text.slice(0, TOOL_CONTENT_TRUNCATE_LENGTH);
  return html`
    <div>
      <pre class=${className}>${shown}${!expanded && isLong ? "…" : ""}</pre>
      ${
        isLong
          ? html`<button
              class="permission-btn tool-content-expand-btn"
              onClick=${() => setExpanded(!expanded)}
            >
              ${expanded ? "Show less" : "Show more"}
            </button>`
          : null
      }
    </div>
  `;
}

function ToolCallContentView({
  content,
}: {
  content: ToolCallUpdate["content"];
}) {
  if (!content || content.length === 0) {
    return null;
  }
  return content.map((item, index) => {
    if (item.type === "content") {
      return html`<${TruncatedPre}
        key=${index}
        text=${textOf(item.content)}
        class="tool-content-text"
      />`;
    }
    if (item.type === "diff") {
      // No extra <details> fold here — the tool card itself is already the
      // one collapse point, matching plain content (Read) rendering directly.
      return html`
        <div class="tool-diff" key=${index}>
          <div class="tool-diff-path">${item.path}</div>
          ${item.oldText ? html`<pre class="diff-old">${item.oldText}</pre>` : null}
          <pre class="diff-new">${item.newText}</pre>
        </div>
      `;
    }
    return html`<div class="tool-content-other" key=${index}>
      [terminal output]
    </div>`;
  });
}

function ToolCardView({
  item,
  defaultOpen,
}: {
  item: ToolItem;
  defaultOpen?: boolean;
}) {
  const ref = useOpenOnMount(defaultOpen);
  return html`
    <details class="tool-card" ref=${ref} title=${debugTitle(item)}>
      <summary class="tool-card-header">
        ${
          !showsOwnKindLabel(item.kind, item.title)
            ? html`<span class="tool-card-kind"
                >${TOOL_KIND_LABELS[item.kind]}</span
              >`
            : null
        }
        <span class="tool-card-title">${item.title}</span>
        <span class="tool-card-status">${item.status}</span>
      </summary>
      <div class="tool-card-body">
        <${ToolCallContentView} content=${item.content} />
      </div>
    </details>
  `;
}

function PermissionCardView({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const resolved = item.resolvedOptionId !== undefined;
  return html`
    <div
      class="permission-card ${resolved ? "permission-resolved" : ""}"
      title=${debugTitle(item)}
    >
      <div class="permission-title">
        ${!showsOwnKindLabel(item.kind, item.title) ? `${TOOL_KIND_LABELS[item.kind]}: ` : ""}${item.title}
      </div>
      <div class="permission-buttons">
        ${item.options.map(
          option => html`
            <button
              key=${option.optionId}
              class="permission-btn permission-${option.kind}"
              disabled=${resolved}
              onClick=${() => onRespond(item.requestId, option.optionId)}
            >
              ${option.name}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function ThoughtCardView({
  item,
  defaultOpen,
}: {
  item: TextItem;
  defaultOpen?: boolean;
}) {
  const ref = useOpenOnMount(defaultOpen);
  return html`
    <details
      class="tool-card thought-card"
      ref=${ref}
      title=${debugTitle(item)}
    >
      <summary class="tool-card-header">Thought</summary>
      <${MarkdownBody} text=${item.text} class="bubble bubble-thought" />
    </details>
  `;
}

function TurnItemView({
  item,
  onRespond,
  defaultOpen,
}: {
  item: TurnItem;
  onRespond: (requestId: string, optionId: string) => void;
  defaultOpen?: boolean;
}) {
  if (item.type === "text") {
    if (item.role === "thought") {
      return html`<${ThoughtCardView}
        item=${item}
        defaultOpen=${defaultOpen}
      />`;
    }
    return html`<${MarkdownBody}
      text=${item.text}
      class="bubble bubble-agent"
      debug=${item}
    />`;
  }
  if (item.type === "tool") {
    return html`<${ToolCardView} item=${item} defaultOpen=${defaultOpen} />`;
  }
  return html`<${PermissionCardView} item=${item} onRespond=${onRespond} />`;
}

/** Everything the agent produces between two user messages is one turn: only
 *  the most recent item stays visible at the top level, every earlier item
 *  folds into a collapsible "Completed N steps" wrapper — matches VS Code's
 *  own chat view. No duration in the label: ACP doesn't carry per-update
 *  timestamps, so there's no real elapsed time to report. */
function TurnBlockView({
  turn,
  onRespond,
  live,
}: {
  turn: TurnBlock;
  onRespond: (requestId: string, optionId: string) => void;
  live: boolean;
}) {
  const items = turn.items;
  if (items.length <= 1) {
    return items.map(
      item =>
        html`<${TurnItemView}
          key=${item.id}
          item=${item}
          onRespond=${onRespond}
          defaultOpen=${live}
        />`,
    );
  }
  const folded = items.slice(0, -1);
  const last = items[items.length - 1];
  return [
    html`
      <details class="tool-card tool-chain" key="${turn.id}-chain">
        <summary class="tool-card-header">
          <span class="tool-card-title"
            >Completed ${folded.length}
            step${folded.length === 1 ? "" : "s"}</span
          >
        </summary>
        <div class="tool-chain-body">
          ${folded.map(item => html`<${TurnItemView} key=${item.id} item=${item} onRespond=${onRespond} />`)}
        </div>
      </details>
    `,
    html`<${TurnItemView}
      key=${last.id}
      item=${last}
      onRespond=${onRespond}
      defaultOpen=${live}
    />`,
  ];
}

function NoteView({ block, onFork }: { block: NoteBlock; onFork: () => void }) {
  return html`
    <div
      class=${block.kind === "error" ? "system-note-error" : "system-note"}
      title=${debugTitle(block)}
    >
      <div>${block.text}</div>
      ${
        block.forkable
          ? html`<button class="permission-btn" onClick=${onFork}>
              Fork session
            </button>`
          : null
      }
    </div>
  `;
}

function BlocksView({
  blocks,
  onRespond,
  onFork,
  busy,
}: {
  blocks: Block[];
  onRespond: (requestId: string, optionId: string) => void;
  onFork: () => void;
  busy: boolean;
}) {
  return blocks.map((block, index) => {
    if (block.type === "note") {
      return html`<${NoteView}
        key=${block.id}
        block=${block}
        onFork=${onFork}
      />`;
    }
    if (block.type === "user") {
      return html`<div
        key=${block.id}
        class="bubble bubble-user"
        title=${debugTitle(block)}
      >
        ${linkify(block.text)}
      </div>`;
    }
    const live = busy && index === blocks.length - 1;
    return html`<${TurnBlockView}
      key=${block.id}
      turn=${block}
      onRespond=${onRespond}
      live=${live}
    />`;
  });
}

// Only while the whole message is still just "/" + a bare command name (no
// space yet) — once a space appears the user's typing the command's
// arguments, not still choosing which command, so the popup should be gone.
function matchSlashCommand(text: string): string | undefined {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1] : undefined;
}

/** True if every character of `query` appears in `target`, in order (not
 *  necessarily contiguous) — same idea as VS Code's own command-palette/quick-
 *  open matching, just without the match-position highlighting. */
function fuzzyMatches(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++;
    }
  }
  return qi === query.length;
}

function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
}: {
  commands: AvailableCommand[];
  selectedIndex: number;
  onSelect: (command: AvailableCommand) => void;
}) {
  return html`
    <div class="slash-menu">
      ${commands.map(
        (command, index) => html`
          <button
            key=${command.name}
            type="button"
            class="slash-menu-item ${index === selectedIndex ? "slash-menu-item-selected" : ""}"
            onClick=${() => onSelect(command)}
          >
            <span class="slash-menu-name">/${command.name}</span>
            <span class="slash-menu-description"
              >${command.input?.hint ?? command.description}</span
            >
          </button>
        `,
      )}
    </div>
  `;
}

function Composer({
  state,
  onSend,
  onCancel,
  onDraftChange,
}: {
  state: ViewState;
  onSend: (text: string) => void;
  onCancel: () => void;
  onDraftChange: (text: string) => void;
}) {
  const disabled = !state.meta;
  // Sending mid-turn ("steering") only works when the connected agent
  // implements `_session/steering` — without it, a second `session/prompt`
  // would interrupt the running turn instead of injecting into it, so fall
  // back to the old block-until-idle behavior for agents that don't.
  const steeringBlocked = state.busy && !state.meta?.canSteer;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // <textarea> has no reactive "grow with content" CSS in this Chromium
  // build — recompute height from scrollHeight on every text change instead;
  // main.css caps it with max-height + overflow-y so it scrolls internally
  // past that instead of growing forever.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [state.draftText]);

  const partial = matchSlashCommand(state.draftText);
  useEffect(() => {
    setSelectedIndex(0);
    setDismissed(false);
  }, [partial]);
  const suggestions =
    partial === undefined || dismissed
      ? []
      : state.availableCommands
          .filter(command => fuzzyMatches(partial.toLowerCase(), command.name.toLowerCase()))
          .sort((a, b) => {
            const aPrefix = a.name.toLowerCase().startsWith(partial.toLowerCase());
            const bPrefix = b.name.toLowerCase().startsWith(partial.toLowerCase());
            return aPrefix === bPrefix ? 0 : aPrefix ? -1 : 1;
          });

  function submit(): void {
    const trimmed = state.draftText.trim();
    if (!trimmed || disabled || steeringBlocked) {
      return;
    }
    onSend(trimmed);
  }

  function selectCommand(command: AvailableCommand): void {
    onDraftChange(`/${command.name} `);
    textareaRef.current?.focus();
  }

  return html`
    <div class="input-bar">
      ${
        suggestions.length > 0
          ? html`<${SlashCommandMenu}
              commands=${suggestions}
              selectedIndex=${selectedIndex}
              onSelect=${selectCommand}
            />`
          : null
      }
      <textarea
        ref=${textareaRef}
        class="prompt-input"
        rows="1"
        placeholder="Message…"
        disabled=${disabled || steeringBlocked}
        value=${state.draftText}
        onInput=${(event: Event) => onDraftChange((event.target as HTMLTextAreaElement).value)}
        onKeyDown=${(event: KeyboardEvent) => {
          if (suggestions.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedIndex(index => (index + 1) % suggestions.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex(
                index => (index - 1 + suggestions.length) % suggestions.length,
              );
              return;
            }
            if (
              event.key === "Tab" ||
              (event.key === "Enter" && !event.shiftKey)
            ) {
              event.preventDefault();
              selectCommand(suggestions[selectedIndex]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(true);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      ></textarea>
      ${
        !steeringBlocked
          ? html`<button
              class="send-btn"
              disabled=${disabled || !state.draftText.trim()}
              onClick=${submit}
            >
              Send
            </button>`
          : null
      }
      ${state.busy ? html`<button class="send-btn cancel-btn" onClick=${onCancel}>Stop</button>` : null}
    </div>
  `;
}

export function Transcript({
  state,
  onSend,
  onCancel,
  onRespond,
  onFork,
  onDraftChange,
}: {
  state: ViewState;
  onSend: (text: string) => void;
  onCancel: () => void;
  onRespond: (requestId: string, optionId: string) => void;
  onFork: () => void;
  onDraftChange: (text: string) => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = logRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  });

  const title = state.meta
    ? `${state.meta.agentName} — ${state.meta.title ?? state.meta.sessionId}`
    : "No session selected";

  return html`
    <div
      class="session-header ${state.meta ? "" : "session-header-placeholder"}"
    >
      ${title}
    </div>
    <div class="chat-log session-log" ref=${logRef}>
      ${state.loading ? html`<div class="system-note">Loading…</div>` : null}
      <${BlocksView}
        blocks=${state.blocks}
        onRespond=${onRespond}
        onFork=${onFork}
        busy=${state.busy}
      />
      ${state.busy ? html`<div class="system-note working-note">${state.statusText ?? "Working…"}</div>` : null}
    </div>
    <${Composer}
      state=${state}
      onSend=${onSend}
      onCancel=${onCancel}
      onDraftChange=${onDraftChange}
    />
  `;
}
