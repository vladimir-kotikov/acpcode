// Session transcript rendering: a pure reducer (ACP updates -> immutable
// block list) plus Preact/htm components that render that list. Everything
// the agent produces (text, tool calls, reasoning, permission requests)
// between two user messages is one "turn" — matches VS Code's own chat view,
// only the most recent item of a turn stays visible at the top level; every
// earlier item is folded into a collapsible "Completed N steps in Ys"
// wrapper. Browser-side only — no vscode (extension host) imports.

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import { html } from "htm/preact";
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { match } from "ts-pattern";
import {
  CollapsibleStep,
  Composer,
  MarkdownBody,
  ThoughtStep,
  ToolStep,
} from "./components/index.ts";
import { Block, NoteBlock, TurnBlock, TurnItem, ViewState } from "./state.ts";

function TurnItemView({
  item,
  onRespond,
  onOpenFile,
}: {
  item: TurnItem;
  onRespond: (requestId: string, optionId: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  if (item.type === "text") {
    if (item.role === "thought") {
      return html`<${ThoughtStep} item=${item} />`;
    }
    // The agent's own reply text — never collapsed, never folded into a
    // "Completed N steps" group, regardless of its position in the turn.
    return html`<${MarkdownBody}
      text=${item.text}
      class="bubble bubble-agent"
    />`;
  }
  return html`<${ToolStep}
    item=${item}
    onRespond=${onRespond}
    onOpenFile=${onOpenFile}
  />`;
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
  onOpenFile,
}: {
  turn: TurnBlock;
  onRespond: (requestId: string, optionId: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}) =>
  groupTurnItems(turn.items).map(group => {
    if (group.kind === "standalone") {
      return html`<${TurnItemView}
        key=${group.item.id}
        item=${group.item}
        onRespond=${onRespond}
        onOpenFile=${onOpenFile}
      />`;
    }

    const groupTitle = `Completed ${group.items.length} step${group.items.length === 1 ? "" : "s"}`;
    return html`<${CollapsibleStep}
      class="step-group"
      key="${group.items[0].id}-fold"
      header=${html`<span class="step-title">${groupTitle}</span>`}
    >
      <div class="step-group-body">
        ${group.items.map(item => html`<${TurnItemView} key=${item.id} item=${item} onRespond=${onRespond} onOpenFile=${onOpenFile} />`)}
      </div>
    <//>`;
  });

function NoteView({ block, onFork }: { block: NoteBlock; onFork: () => void }) {
  return html`
    <div class=${block.kind === "error" ? "system-note-error" : "system-note"}>
      <div>${block.text}</div>
      ${
        block.forkable
          ? html`<button class="btn-secondary" onClick=${onFork}>
              Fork session
            </button>`
          : null
      }
    </div>
  `;
}

interface BlocksViewProps {
  blocks: Block[];
  onRespond: (requestId: string, optionId: string) => void;
  onFork: () => void;
  onOpenFile: (path: string, line?: number) => void;
}

const BlocksView = ({
  blocks,
  onRespond,
  onFork,
  onOpenFile,
}: BlocksViewProps) =>
  blocks.map(block =>
    match(block)
      .with(
        { type: "note" },
        block =>
          html`<${NoteView} key=${block.id} block=${block} onFork=${onFork} />`,
      )
      .with(
        { type: "user" },
        block =>
          html`<${MarkdownBody}
            key=${block.id}
            text=${block.text}
            class="bubble bubble-user"
          />`,
      )
      .with(
        { type: "turn" },
        block =>
          html`<${TurnBlockView}
            key=${block.id}
            turn=${block}
            onRespond=${onRespond}
            onOpenFile=${onOpenFile}
          />`,
      )
      .exhaustive(),
  );

const findConfigOption = (
  configOptions: SessionConfigOption[],
  category: string,
): SessionConfigOption | undefined =>
  configOptions.find(option => option.category === category);

// `options` is a flat list OR a list of groups (e.g. models grouped by
// provider) — never a mix of both at once, but never a mix of item shapes
// within a list either, so a single "does the first entry look like a group"
// check is enough to flatten it into one lookup table.
function flattenSelectOptions(
  options: SessionConfigSelectOption[] | SessionConfigSelectGroup[],
): SessionConfigSelectOption[] {
  return options.some(
    (entry): entry is SessionConfigSelectGroup => "options" in entry,
  )
    ? (options as SessionConfigSelectGroup[]).flatMap(group => group.options)
    : (options as SessionConfigSelectOption[]);
}

// A boolean-typed config option (an on/off toggle) has no `options` list to
// resolve a label from — only "select" options (model, effort, mode) are
// ever worth a stats-strip entry.
function selectedOptionLabel(option: SessionConfigOption): string | undefined {
  if (option.type !== "select") {
    return undefined;
  }
  return flattenSelectOptions(option.options).find(
    o => o.value === option.currentValue,
  )?.name;
}

// Traffic-light coloring so a session nearing its context limit (and thus
// due for auto-compaction) stands out before it happens — thresholds match
// no specific documented bridge behavior, just a conservative heads-up.
function usageLevel(percent: number): "ok" | "warn" | "danger" {
  return percent >= 90 ? "danger" : percent >= 75 ? "warn" : "ok";
}

function UsageMeter({ usage }: { usage: UsageUpdate }) {
  const percent =
    usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : 0;
  const level = usageLevel(percent);
  return html`
    <span
      class="usage-meter usage-meter-${level}"
      title="${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens in context"
    >
      <span class="usage-bar"
        ><span
          class="usage-bar-fill"
          style="width: ${Math.min(percent, 100)}%"
        ></span
      ></span>
      ${percent}%
    </span>
  `;
}

// Model + effort level (Claude's "thought_level" config option) plus context
// usage, all sourced from ACP session updates that already flow through the
// generic update pipeline — see state.ts's extractConfigOptions/extractUsage.
// Renders nothing for an agent that never sends any of these (e.g. codex-acp,
// which may not expose config options or usage_update at all).
function SessionStats({ state }: { state: ViewState }) {
  const model = findConfigOption(state.configOptions, "model");
  const effort = findConfigOption(state.configOptions, "thought_level");
  const modelLabel = model && selectedOptionLabel(model);
  const effortLabel = effort && selectedOptionLabel(effort);
  if (!modelLabel && !effortLabel && !state.usage) {
    return null;
  }
  return html`
    <div class="session-stats">
      ${modelLabel ? html`<span>${modelLabel}</span>` : null}
      ${effortLabel ? html`<span>${effortLabel}</span>` : null}
      ${state.usage ? html`<${UsageMeter} usage=${state.usage} />` : null}
    </div>
  `;
}

interface TranscriptProps {
  state: ViewState;
  atBottomRef: RefObject<boolean>;
  onSend: (text: string) => void;
  onCancel: () => void;
  onRespond: (requestId: string, optionId: string) => void;
  onFork: () => void;
  onOpenFile: (path: string, line?: number) => void;
  onDraftChange: (text: string) => void;
}

export function Transcript({
  state,
  atBottomRef,
  onSend,
  onCancel,
  onRespond,
  onFork,
  onOpenFile,
  onDraftChange,
}: TranscriptProps) {
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
    ${
      state.meta
        ? html`<div class="session-header">
            ${state.meta.agentName} —
            ${state.meta.title ?? state.meta.sessionId}
            <${SessionStats} state=${state} />
          </div>`
        : null
    }
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
                onOpenFile=${onOpenFile}
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
