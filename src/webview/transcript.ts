// Session transcript rendering: a pure reducer (ACP updates -> immutable
// block list) plus Preact/htm components that render that list. Everything
// the agent produces (text, tool calls, reasoning, permission requests)
// between two user messages is one "turn" — matches VS Code's own chat view,
// only the most recent item of a turn stays visible at the top level; every
// earlier item is folded into a collapsible "Completed N steps in Ys"
// wrapper. Browser-side only — no vscode (extension host) imports.

import type {
  AvailableCommand,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { diffLines } from "diff";
import hljs from "highlight.js";
import { html } from "htm/preact";
import { marked } from "marked";
import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  Block,
  NoteBlock,
  PendingPermission,
  TextItem,
  textOf,
  ToolItem,
  TurnBlock,
  TurnItem,
  ViewState,
} from "./state.ts";

marked.setOptions({ breaks: true });

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
const showsOwnKindLabel = (kind: ToolKind, title: string): boolean =>
  title.toLowerCase().startsWith(TOOL_KIND_LABELS[kind].toLowerCase());

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

/** Renders markdown for agent, thought, and user text alike; re-parses the
 *  full accumulated text on
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
    class="markdown-body ${className}"
    ref=${ref}
    title=${debug !== undefined ? debugTitle(debug) : undefined}
    dangerouslySetInnerHTML=${{ __html: rendered }}
  ></div>`;
}

/** Shared `<details class="tool-card">`/`<summary>` scaffold for tool cards,
 *  thought cards, and folded "Completed N steps" groups — the one part of
 *  each that isn't specific to what's inside.
 *
 *  `defaultOpen` has no reactive "open" prop to bind to — it's a one-time
 *  initial value, set imperatively so a later re-render (e.g. the status
 *  text updating) doesn't fight a user who's manually collapsed it back.
 *  Used to default the currently in-progress step of a live turn open, so
 *  there's visible progress instead of every step looking collapsed the
 *  instant it appears. */
const CollapsibleCard = ({
  class: className = "",
  defaultOpen,
  titleAttr,
  summary,
  children,
}: {
  class?: string;
  defaultOpen?: boolean;
  titleAttr?: string;
  summary: VNode | string;
  children: VNode | (VNode | null)[];
}) => {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (defaultOpen && ref.current) {
      ref.current.open = true;
    }
  }, []);
  return html`
    <details class="tool-card ${className}" ref=${ref} title=${titleAttr}>
      <summary class="tool-card-header">${summary}</summary>
      ${children}
    </details>
  `;
};

// Full tool output (a whole file's contents, a long command's stdout) can run
// to thousands of lines — collapse past this many by default with a "Show
// more" toggle, same idea as the tool card itself being collapsed.
const TOOL_CONTENT_TRUNCATE_LINES = 20;

function TruncatedPre({
  text,
  class: className,
}: {
  text: string;
  class: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const isLong = lines.length > TOOL_CONTENT_TRUNCATE_LINES;
  const shown =
    expanded || !isLong
      ? text
      : lines.slice(0, TOOL_CONTENT_TRUNCATE_LINES).join("\n");
  return html`
    <div>
      <pre class=${className}>${shown}${!expanded && isLong ? "\n…" : ""}</pre>
      ${
        isLong
          ? html`<button
              class="permission-btn"
              onClick=${() => setExpanded(!expanded)}
            >
              ${expanded ? "Show less" : "Show more"}
            </button>`
          : null
      }
    </div>
  `;
}

// Shell/execute output routinely arrives already wrapped by the agent in a
// markdown fence (e.g. ```console ... ```), formatted for a markdown-rendering
// client. We render tool content as plain text on purpose (raw output can
// contain its own literal markdown-looking characters that shouldn't be
// reinterpreted), so an outer fence just shows up as literal backticks
// instead of being stripped the way a markdown renderer would. The <pre>
// styling already conveys "this is code" — unwrap a well-formed wrapping
// fence rather than displaying its markers.
function stripCodeFence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return match ? match[1] : text;
}

type DiffLineKind = "add" | "remove" | "context";
interface DiffLine {
  text: string;
  kind: DiffLineKind;
}

function toDiffLines(oldText: string, newText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const change of diffLines(oldText, newText)) {
    const kind: DiffLineKind = change.added
      ? "add"
      : change.removed
        ? "remove"
        : "context";
    const chunkLines = change.value.split("\n");
    // diffLines' value always ends with "\n" except possibly the very last
    // chunk of the whole diff - drop the empty string that split() leaves.
    if (chunkLines[chunkLines.length - 1] === "") {
      chunkLines.pop();
    }
    for (const text of chunkLines) {
      lines.push({ text, kind });
    }
  }
  return lines;
}

// Real diffs collapse long unchanged spans to a few lines of surrounding
// context (like `git diff -U3`) rather than dumping the whole file — without
// this, a one-line change in a long file would render as a wall of unchanged
// text either side.
const DIFF_CONTEXT_LINES = 3;

function windowDiffContext(
  lines: DiffLine[],
): (DiffLine | { kind: "ellipsis" })[] {
  const result: (DiffLine | { kind: "ellipsis" })[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "context") {
      result.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === "context") {
      j++;
    }
    const keepBefore = i === 0 ? 0 : DIFF_CONTEXT_LINES;
    const keepAfter = j === lines.length ? 0 : DIFF_CONTEXT_LINES;
    if (j - i <= keepBefore + keepAfter) {
      result.push(...lines.slice(i, j));
    } else {
      result.push(...lines.slice(i, i + keepBefore));
      result.push({ kind: "ellipsis" });
      result.push(...lines.slice(j - keepAfter, j));
    }
    i = j;
  }
  return result;
}

const DIFF_LINE_PREFIX: Record<DiffLineKind, string> = {
  add: "+ ",
  remove: "- ",
  context: "  ",
};

function DiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const lines = windowDiffContext(toDiffLines(oldText, newText));
  // No whitespace between <pre> and the mapped lines: <pre> preserves it
  // literally, and a stray indentation/newline text node here would show up
  // as a visible blank line.
  return html`<div class="tool-diff">
    <div class="tool-diff-path">${path}</div>
    <pre class="diff-lines">
${lines.map((line, index) =>
  line.kind === "ellipsis"
    ? html`<div class="diff-line diff-line-ellipsis" key=${index}>⋯</div>`
    : html`<div class="diff-line diff-line-${line.kind}" key=${index}>
        ${DIFF_LINE_PREFIX[line.kind]}${line.text}
      </div>`,
)}</pre>
  </div>`;
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
        text=${stripCodeFence(textOf(item.content))}
        class="tool-content-text"
      />`;
    }
    if (item.type === "diff") {
      // No extra <details> fold here — the tool card itself is already the
      // one collapse point, matching plain content (Read) rendering directly.
      return html`<${DiffView}
        key=${index}
        path=${item.path}
        oldText=${item.oldText ?? ""}
        newText=${item.newText}
      />`;
    }
    return html`<div class="tool-content-other" key=${index}>
      [terminal output]
    </div>`;
  });
}

// Rendered inside a tool card's body, right below its diff/content, instead
// of as a separate card elsewhere — the whole point is the user can see the
// actual change next to the buttons approving it.
function PendingPermissionView({
  pendingPermission,
  onRespond,
}: {
  pendingPermission: PendingPermission;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const resolved = pendingPermission.resolvedOptionId !== undefined;
  return html`
    <div class="permission-card ${resolved ? "permission-resolved" : ""}">
      <div class="permission-buttons">
        ${pendingPermission.options.map(
          option => html`
            <button
              key=${option.optionId}
              class="permission-btn permission-${option.kind}"
              disabled=${resolved}
              onClick=${() => onRespond(pendingPermission.requestId, option.optionId)}
            >
              ${option.name}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function ToolCardView({
  item,
  onRespond,
}: {
  item: ToolItem;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  // Collapsed by default, always — except a pending approval, which needs to
  // actually be visible (not hidden behind a card the user has to think to
  // expand) until it's resolved, at which point it collapses like any other.
  const pendingApproval =
    item.pendingPermission?.resolvedOptionId === undefined &&
    !!item.pendingPermission;
  return html`<${CollapsibleCard}
    defaultOpen=${pendingApproval}
    titleAttr=${debugTitle(item)}
    summary=${html`
      ${
        !showsOwnKindLabel(item.kind, item.title)
          ? html`<span class="tool-card-kind"
              >${TOOL_KIND_LABELS[item.kind]}</span
            >`
          : null
      }
      <span class="tool-card-title">${item.title}</span>
      <span class="tool-card-status">${item.status}</span>
    `}
  >
    <div class="tool-card-body">
      <${ToolCallContentView} content=${item.content} />
      ${
        item.pendingPermission
          ? html`<${PendingPermissionView}
              pendingPermission=${item.pendingPermission}
              onRespond=${onRespond}
            />`
          : null
      }
    </div>
  <//>`;
}

// Reasoning/scratch output — collapsed by default like a tool call, never
// forced open (thoughts don't need approval).
const ThoughtCardView = ({ item }: { item: TextItem }) =>
  html`<${CollapsibleCard}
    class="thought-card"
    titleAttr=${debugTitle(item)}
    summary="Thought"
  >
    <${MarkdownBody} text=${item.text} class="bubble bubble-thought" />
  <//>`;

function TurnItemView({
  item,
  onRespond,
}: {
  item: TurnItem;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  if (item.type === "text") {
    if (item.role === "thought") {
      return html`<${ThoughtCardView} item=${item} />`;
    }
    // The agent's own reply text — never collapsed, never folded into a
    // "Completed N steps" group, regardless of its position in the turn.
    return html`<${MarkdownBody}
      text=${item.text}
      class="bubble bubble-agent"
      debug=${item}
    />`;
  }
  return html`<${ToolCardView} item=${item} onRespond=${onRespond} />`;
}

// A tool/thought item is "foldable" (collapsed by default, eligible to join
// a "Completed N steps" group) unless it's a permission request still
// waiting on the user — that one needs to stand out on its own until
// resolved. Agent reply text is never foldable at all.
function isFoldable(item: TurnItem): boolean {
  if (item.type === "text") {
    return item.role === "thought";
  }
  return !(
    item.pendingPermission &&
    item.pendingPermission.resolvedOptionId === undefined
  );
}

type RenderGroup =
  | { kind: "standalone"; item: TurnItem }
  | { kind: "folded"; items: TurnItem[] };

/** Groups consecutive foldable items into one "Completed N steps" wrapper;
 *  a non-foldable item (agent text, or a still-pending permission request)
 *  breaks the run and stands on its own, so e.g. 5 collapsed calls, an agent
 *  message, then 3 more collapsed calls renders as two separate "Completed…"
 *  groups either side of the visible message, not one covering everything. A
 *  run of exactly one foldable item doesn't get an extra wrapper around the
 *  single already-collapsed card. */
function groupTurnItems(items: TurnItem[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let run: TurnItem[] = [];
  const flush = () => {
    if (run.length === 1) {
      groups.push({ kind: "standalone", item: run[0] });
    } else if (run.length > 1) {
      groups.push({ kind: "folded", items: run });
    }
    run = [];
  };
  for (const item of items) {
    if (isFoldable(item)) {
      run.push(item);
    } else {
      flush();
      groups.push({ kind: "standalone", item });
    }
  }
  flush();
  return groups;
}

/** Everything the agent produces between two user messages is one turn. No
 *  duration in the "Completed…" label: ACP doesn't carry per-update
 *  timestamps, so there's no real elapsed time to report. */
const TurnBlockView = ({
  turn,
  onRespond,
}: {
  turn: TurnBlock;
  onRespond: (requestId: string, optionId: string) => void;
}) =>
  groupTurnItems(turn.items).map(group => {
    if (group.kind === "standalone") {
      return html`<${TurnItemView}
        key=${group.item.id}
        item=${group.item}
        onRespond=${onRespond}
      />`;
    }

    const groupTitle = `Completed ${group.items.length} step${group.items.length === 1 ? "" : "s"}`;
    return html`<${CollapsibleCard}
      class="tool-chain"
      key="${group.items[0].id}-fold"
      summary=${html`<span class="tool-card-title">${groupTitle}</span>`}
    >
      <div class="tool-chain-body">
        ${group.items.map(item => html`<${TurnItemView} key=${item.id} item=${item} onRespond=${onRespond} />`)}
      </div>
    <//>`;
  });

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
}: {
  blocks: Block[];
  onRespond: (requestId: string, optionId: string) => void;
  onFork: () => void;
}) {
  return blocks.map(block => {
    if (block.type === "note") {
      return html`<${NoteView}
        key=${block.id}
        block=${block}
        onFork=${onFork}
      />`;
    }
    if (block.type === "user") {
      return html`<${MarkdownBody}
        key=${block.id}
        text=${block.text}
        class="bubble bubble-user"
        debug=${block}
      />`;
    }
    return html`<${TurnBlockView}
      key=${block.id}
      turn=${block}
      onRespond=${onRespond}
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

function SendIcon() {
  return html`<svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="currentColor"
  >
    <path d="M8 2 13 8H10V14H6V8H3Z" />
  </svg>`;
}

function StopIcon() {
  return html`<svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="currentColor"
  >
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>`;
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
          .filter(command =>
            fuzzyMatches(partial.toLowerCase(), command.name.toLowerCase()),
          )
          .sort((a, b) => {
            const aPrefix = a.name
              .toLowerCase()
              .startsWith(partial.toLowerCase());
            const bPrefix = b.name
              .toLowerCase()
              .startsWith(partial.toLowerCase());
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
      ${(() => {
        // One button instead of two: while busy, it's "Send" (steering)
        // whenever there's actually something typed to inject, otherwise
        // there's nothing useful Send could do — "Stop" is the only
        // meaningful action, so that's what takes over the slot.
        const canSend =
          !disabled && !steeringBlocked && !!state.draftText.trim();
        const showStop = state.busy && !canSend;
        return html`<button
          class="send-btn ${showStop ? "cancel-btn" : ""}"
          disabled=${!showStop && !canSend}
          onClick=${() => (showStop ? onCancel() : submit())}
        >
          ${showStop ? html`<${StopIcon} />` : html`<${SendIcon} />`}
          ${showStop ? "Stop" : "Send"}
        </button>`;
      })()}
    </div>
  `;
}

export function Transcript({
  state,
  atBottomRef,
  onSend,
  onCancel,
  onRespond,
  onFork,
  onDraftChange,
}: {
  state: ViewState;
  atBottomRef: { current: boolean };
  onSend: (text: string) => void;
  onCancel: () => void;
  onRespond: (requestId: string, optionId: string) => void;
  onFork: () => void;
  onDraftChange: (text: string) => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  // Whether the user was scrolled at/near the bottom, tracked continuously by
  // a scroll listener rather than computed inside the content-update effect
  // below: by the time that effect runs, the DOM has already grown to fit
  // the new content, so scrollHeight no longer reflects "where things stood
  // right before this update" — checking there would always read as "not at
  // the bottom" the instant anything taller than the old scrollback arrives.
  // Owned by the caller (Root, in sessionView.ts) so onSend can force it to
  // true directly — sending overrides wherever the user's currently
  // scrolled, they just acted, they want to see it happen.
  useEffect(() => {
    const node = logRef.current;
    if (!node) {
      return;
    }
    const onScroll = () => {
      const distanceFromBottom =
        node.scrollHeight - node.scrollTop - node.clientHeight;
      atBottomRef.current = distanceFromBottom < 48;
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, []);
  // Scoped to what actually changes .chat-log's content height — NOT every
  // render. With no dependency array this used to also fire on every
  // composer keystroke (draftText changes), and since typing while scrolled
  // within 48px of the bottom leaves atBottomRef true, it would yank the
  // view back down on the very next character, reading as "scroll doesn't
  // work" while composing a reply.
  useEffect(() => {
    const node = logRef.current;
    if (!node || !atBottomRef.current) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    // A reply's height can still settle a frame after this runs (e.g.
    // MarkdownBody's own effect wrapping a <pre> in .code-block after this
    // commit) — re-snap once more post-paint so a fast-arriving message
    // doesn't land a line or two short of the true bottom.
    const raf = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [
    state.blocks,
    state.loading,
    state.busy,
    state.statusText,
    state.pendingSteerText,
  ]);

  // Covers every "there's nothing real to show yet" phase in one place —
  // connecting (agent connection, possibly a fresh subprocess, still being
  // established), loading (connected, history replay in flight), and the
  // genuine idle state (no session chosen at all) — each centered in the
  // viewport rather than left as a blank pane or squeezed into the header
  // bar, so there's always a reason visible for why the transcript is empty.
  const centerStatus = state.connecting
    ? "Starting bridge…"
    : !state.meta
      ? "No session selected"
      : state.loading
        ? "Loading session…"
        : undefined;
  const showSpinner = state.connecting || (!!state.meta && state.loading);

  return html`
    <div
      class="session-header ${state.meta ? "" : "session-header-placeholder"}"
    >
      ${title}
    </div>
    <div class="chat-log session-log" ref=${logRef}>
      ${
        centerStatus
          ? html`<div class="center-status">
              ${showSpinner ? html`<div class="spinner"></div>` : null}
              <div>${centerStatus}</div>
            </div>`
          : html`
      <${BlocksView}
        blocks=${state.blocks}
        onRespond=${onRespond}
        onFork=${onFork}
      />
              ${
                state.pendingSteerText !== undefined
                  ? html`<${MarkdownBody}
                      text=${state.pendingSteerText}
                      class="bubble bubble-user bubble-pending"
                    />`
                  : null
              }
      ${state.busy ? html`<div class="system-note working-note">${state.statusText ?? "Working…"}</div>` : null}
            `
      }
    </div>
    <${Composer}
      state=${state}
      onSend=${onSend}
      onCancel=${onCancel}
      onDraftChange=${onDraftChange}
    />
  `;
}
