import { match } from "ts-pattern";

import {
  ContentBlock,
  ToolKind,
  type AvailableCommand,
  type PermissionOption,
  type SessionConfigOption,
  type SessionId,
  type SessionUpdate,
  type StopReason,
  type ToolCallUpdate,
  type UsageUpdate,
} from "@agentclientprotocol/sdk";
import type { SessionViewMeta } from "../shared/sessionViewProtocol.ts";

export type Action =
  // `restoredDraftText`: an in-progress draft recovered from vscode.setState
  // (see sessionView.ts) — only meaningful the first time a freshly-mounted
  // webview loads, when the in-memory `drafts` map below is still empty and
  // has nothing of its own to offer for this session.
  | { type: "connecting" }
  | { type: "loading"; meta: SessionViewMeta; restoredDraftText?: string }
  | { type: "sessionUpdate"; sessionId: SessionId; update: SessionUpdate }
  | {
      type: "replayBatch";
      sessionId: SessionId;
      updates: SessionUpdate[];
      busy: boolean;
    }
  | { type: "error"; message: string; forkable?: boolean }
  | { type: "sendStart" }
  | { type: "promptStopped"; sessionId: SessionId; stopReason: StopReason }
  // `pendingSteerText`: set only when this send is a steer (busy + canSteer)
  // — shown as a dimmed provisional bubble until the real echo arrives (see
  // ViewState.pendingSteerText). A plain send needs no provisional bubble:
  // its real echo lands the instant `prompt()` is called, host-side, well
  // before any reply — see AgentClient.echoUserMessage's comment.
  | { type: "draftSent"; pendingSteerText?: string }
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

export interface PendingPermission {
  requestId: string;
  options: PermissionOption[];
  // undefined = pending, null = resolved without knowing which option (e.g.
  // the request was aborted host-side), string = the clicked option's id.
  resolvedOptionId: string | null | undefined;
}

export interface TextItem {
  type: "text";
  id: string;
  role: "agent" | "thought";
  text: string;
}

export interface ToolItem {
  type: "tool";
  id: string;
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: string;
  content: ToolCallUpdate["content"];
  // A permission request always references a toolCallId a tool_call
  // (update) already uses or will use — kept on the tool item itself rather
  // than as a separate turn item so approval UI always renders right next to
  // the change it's asking about, not as a disconnected card elsewhere.
  pendingPermission?: PendingPermission;
  // Derived from the update's `locations` (ACP's own "follow-along" field) —
  // `line`/`endLine` span every entry sharing the first entry's path, since
  // a ranged read (offset/limit) reports one `ToolCallLocation` per line
  // covered rather than a single start/end pair.
  location?: { path: string; line?: number; };
}

export type TurnItem = TextItem | ToolItem;

export interface TurnBlock {
  type: "turn";
  id: string;
  items: TurnItem[];
}

export interface NoteBlock {
  type: "note";
  id: string;
  kind: "info" | "error";
  text: string;
  // Offers a "Fork session" button — set when this error was the session
  // being currently owned by a live background-agent process elsewhere.
  forkable?: boolean;
}

export interface UserBlock {
  type: "user";
  id: string;
  text: string;
}

export type Block = NoteBlock | UserBlock | TurnBlock;

export interface ViewState {
  meta: SessionViewMeta | undefined;
  blocks: Block[];
  busy: boolean;
  loading: boolean;
  // True from `attachSession`'s very first line until the agent connection
  // resolves (may mean spawning a fresh subprocess) — distinct from
  // `loading`, which only starts once a connection exists. Lets the empty
  // state distinguish "no session chosen" from "one's on its way."
  connecting: boolean;
  // A steer send shows here — dimmed, at the bottom of the transcript —
  // until AgentClient.steer's post-request echo comes back around as a real
  // "sessionUpdate"/"replayBatch" (cleared there; see the reducer). Unset for
  // a plain (non-steering) send, which never has a provisional phase.
  pendingSteerText: string | undefined;
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
  // Model/effort/mode selectors the agent exposes for this session (category
  // "model" | "thought_level" | "mode" | ...). Seeded from `loadSession`'s
  // response by sessionViewProvider.ts (synthesized as a leading
  // config_option_update in the replay buffer, since ACP has no dedicated
  // "loading" field for it) and kept current by later live
  // config_option_update notifications (e.g. the user runs `/model`).
  configOptions: SessionConfigOption[];
  // Context-window usage for this session. Unlike configOptions, ACP has no
  // initial snapshot for this — the bridge only emits usage_update live, as
  // part of a turn's streaming response — so this stays undefined for a
  // freshly reopened session until the next prompt actually runs.
  usage: UsageUpdate | undefined;
}

// The slice of ViewState that one SessionUpdate can touch — shared by
// "sessionUpdate" (one live update) and "replayBatch" (folded over N
// replayed updates) so the two paths can't silently drift apart on what
// counts as a failure note vs. a transient status line.
interface UpdateResult {
  blocks: Block[];
  statusText: string | undefined;
  availableCommands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  usage: UsageUpdate | undefined;
}

export const initialState: ViewState = {
  meta: undefined,
  blocks: [],
  busy: false,
  loading: false,
  connecting: false,
  pendingSteerText: undefined,
  draftText: "",
  drafts: new Map(),
  statusText: undefined,
  availableCommands: [],
  configOptions: [],
  usage: undefined,
};

export const reduce = (state: ViewState, action: Action): ViewState =>
  match(action)
    .returnType<ViewState>()
    // Deliberately leaves `meta`/`blocks` untouched — a re-attach that's
    // still waiting on `pool.connect()` shouldn't blank out whatever the
    // view was showing before; `connecting` alone drives the centered
    // spinner (see Transcript), layered over whatever's still there.
    .with({ type: "connecting" }, () => ({ ...state, connecting: true }))
    .with({ type: "loading" }, action => {
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
        connecting: false,
        pendingSteerText: undefined,
        draftText:
          drafts.get(action.meta.sessionId) ?? action.restoredDraftText ?? "",
        drafts,
        statusText: undefined,
        availableCommands: [],
        configOptions: [],
        usage: undefined,
      };
    })
    .with({ type: "error" }, action => ({
      ...state,
      blocks: [
        ...state.blocks,
        {
          type: "note",
          id: genId(),
          kind: "error",
          text: action.message,
          forkable: action.forkable,
        },
      ],
      busy: false,
      loading: false,
      connecting: false,
      pendingSteerText: undefined,
      statusText: undefined,
    }))
    .with({ type: "sendStart" }, () => ({
      ...state,
      busy: true,
      statusText: undefined,
    }))
    .with({ type: "promptStopped" }, action =>
      action.sessionId === state.meta?.sessionId
        ? { ...state, busy: false, statusText: undefined }
        : state,
    )
    // The user bubble itself now always arrives through "sessionUpdate" (see
    // AgentClient.echoUserMessage) so every view showing this session gets
    // it, not just whichever one sent it — this action only clears the
    // composer, dispatched locally for instant feedback on click.
    .with({ type: "draftSent" }, action => {
      const drafts = new Map(state.drafts);
      if (state.meta) {
        drafts.delete(state.meta.sessionId);
      }
      return {
        ...state,
        draftText: "",
        drafts,
        pendingSteerText: action.pendingSteerText,
      };
    })
    .with({ type: "draftChanged" }, action => ({
      ...state,
      draftText: action.text,
    }))
    .with({ type: "sessionUpdate" }, action =>
      action.sessionId === state.meta?.sessionId
        ? {
            ...state,
            ...applyOneUpdate(state, action.update),
            loading: false,
            // Any real content for this session is the earliest point a
            // pending steer can have landed for real (AgentClient.steer only
            // echoes after its request resolves) — clear the provisional
            // bubble so it doesn't sit duplicated alongside the real one.
            pendingSteerText: undefined,
          }
        : state,
    )
    .with({ type: "replayBatch" }, action =>
      action.sessionId === state.meta?.sessionId
        ? {
            ...state,
            pendingSteerText: undefined,
            ...action.updates.reduce<UpdateResult>(applyOneUpdate, state),
            loading: false,
            busy: action.busy,
          }
        : state,
    )
    .with({ type: "permissionRequest" }, action =>
      action.sessionId !== state.meta?.sessionId
        ? state
        : {
            ...state,
            blocks: upsertToolCall(state.blocks, action.toolCall, {
              requestId: action.requestId,
              options: action.options,
              resolvedOptionId: undefined,
            }),
            loading: false,
          },
    )
    // The click resolves this view's own copy instantly and always wins —
    // it's the freshest information there is, so no "already resolved"
    // guard is needed here (contrast permissionResolved below).
    .with({ type: "localPermissionResponse" }, action => ({
      ...state,
      blocks: resolvePendingPermission(
        state.blocks,
        action.requestId,
        action.optionId,
        { onlyIfPending: false },
      ),
    }))
    // The server-side echo of a resolution — sent to every view sharing the
    // connection, not just whichever one the click happened in — carries no
    // optionId (`null` here just means "no longer pending"), so it must not
    // clobber a `resolvedOptionId` a local click already recorded for this
    // same request; onlyIfPending skips items that are already resolved.
    .with({ type: "permissionResolved" }, action => ({
      ...state,
      blocks: resolvePendingPermission(state.blocks, action.requestId, null, {
        onlyIfPending: true,
      }),
    }))
    .with({ type: "closed" }, () => ({ ...initialState, drafts: new Map() }))
    .exhaustive();

const applySessionUpdate = (blocks: Block[], update: SessionUpdate): Block[] =>
  match(update)
    .returnType<Block[]>()
    .with({ sessionUpdate: "user_message_chunk" }, u =>
      appendUserChunk(blocks, textOf(u.content)),
    )
    .with({ sessionUpdate: "agent_message_chunk" }, u =>
      appendText(blocks, "agent", textOf(u.content)),
    )
    .with({ sessionUpdate: "agent_thought_chunk" }, u =>
      appendText(blocks, "thought", textOf(u.content)),
    )
    .with(
      { sessionUpdate: "tool_call" },
      { sessionUpdate: "tool_call_update" },
      u => upsertToolCall(blocks, u),
    )
    .otherwise(
      // plan/plan_update/current_mode_update — not rendered yet, no-op.
      // available_commands_update, session_info_update, config_option_update,
      // and usage_update ARE handled, just not here — by
      // extractAvailableCommands/extractSessionFailure/extractConfigOptions/
      // extractUsage in the reducer cases that call this function.
      () => blocks,
    );

const applyOneUpdate = (
  prev: UpdateResult,
  update: SessionUpdate,
): UpdateResult => {
  const blocks = applySessionUpdate(prev.blocks, update);
  const failure = extractSessionFailure(update);
  const withFailureNote: Block[] =
    failure?.severity === "error"
      ? [
          ...blocks,
          { type: "note", id: genId(), kind: "error", text: failure.title },
        ]
      : blocks;
  return {
    blocks: withFailureNote,
    statusText:
      failure && failure.severity !== "error"
        ? failure.title
        : withFailureNote !== prev.blocks
          ? undefined
          : prev.statusText,
    availableCommands:
      extractAvailableCommands(update) ?? prev.availableCommands,
    configOptions: extractConfigOptions(update) ?? prev.configOptions,
    usage: extractUsage(update) ?? prev.usage,
  };
};

const resolvePendingPermission = (
  blocks: Block[],
  requestId: string,
  resolvedOptionId: string | null,
  { onlyIfPending }: { onlyIfPending: boolean },
): Block[] =>
  updateTurnItem(
    blocks,
    (item): item is ToolItem =>
      item.type === "tool" &&
      item.pendingPermission?.requestId === requestId &&
      (!onlyIfPending || item.pendingPermission.resolvedOptionId === undefined),
    tool => ({
      ...tool,
      pendingPermission: tool.pendingPermission && {
        ...tool.pendingPermission,
        resolvedOptionId,
      },
    }),
  );

let idCounter = 0;
function genId(): string {
  idCounter += 1;
  return `b${idCounter}`;
}

const lastBlock = (blocks: Block[]): Block | undefined =>
  blocks[blocks.length - 1];

function pushToTurn(blocks: Block[], item: TurnItem): Block[] {
  const last = lastBlock(blocks);
  if (last?.type === "turn") {
    const turn: TurnBlock = { ...last, items: [...last.items, item] };
    return [...blocks.slice(0, -1), turn];
  }
  return [...blocks, { type: "turn", id: genId(), items: [item] }];
}

const replaceLastTurnItem = <T extends TurnItem>(
  blocks: Block[],
  item: T,
  updater: (item: T) => TurnItem,
): Block[] => {
  const last = lastBlock(blocks);
  if (last?.type !== "turn") {
    return blocks;
  }
  const items = [...last.items.slice(0, -1), updater(item)];
  return [...blocks.slice(0, -1), { ...last, items }];
};

const updateTurnItem = <T extends TurnItem>(
  blocks: Block[],
  predicate: (item: TurnItem) => item is T,
  updater: (item: T) => TurnItem,
): Block[] =>
  blocks.map(block => {
    if (block.type !== "turn") {
      return block;
    }
    const items = block.items.map(item =>
      predicate(item) ? updater(item) : item,
    );
    return items.some((item, i) => item !== block.items[i])
      ? { ...block, items }
      : block;
  });

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
  const lastItem = last?.type === "turn" ? last.items.at(-1) : undefined;
  return lastItem?.type === "text" && lastItem.role === role
    ? replaceLastTurnItem(blocks, lastItem, item => ({
        ...item,
        text: item.text + text,
      }))
    : pushToTurn(blocks, { type: "text", id: genId(), role, text });
}

// Shared by tool_call(_update) SessionUpdates and permission requests — a
// permission request always references a toolCallId that a tool_call already
// uses or will use, and both need the same find-or-create-by-toolCallId
// logic. Passing `pendingPermission` attaches/updates it in place; omitting
// it leaves whatever the item already had untouched (a later tool_call_update
// for the same call, e.g. status flipping to "completed", shouldn't erase a
// still-pending — or already-resolved — permission record).
function primaryLocation(
  locations: ToolCallUpdate["locations"],
): { path: string; line?: number; } | undefined {
  const first = locations?.[0];
  if (!first) {
    return undefined;
  }
  const lineNumbers = (locations ?? [])
    .filter(
      (loc): loc is typeof loc & { line: number } =>
        loc.path === first.path && loc.line != null,
    )
    .map(loc => loc.line);
  return {
    path: first.path,
    line: lineNumbers.length ? Math.min(...lineNumbers) : undefined,
  };
}

function upsertToolCall(
  blocks: Block[],
  update: {
    toolCallId: string;
    title?: string | null;
    kind?: ToolKind | null;
    status?: string | null;
    content?: ToolCallUpdate["content"];
    locations?: ToolCallUpdate["locations"];
  },
  pendingPermission?: PendingPermission,
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
      (item): item is ToolItem =>
        item.type === "tool" && item.toolCallId === update.toolCallId,
      tool => ({
        ...tool,
        title: update.title ?? tool.title,
        kind: update.kind ?? tool.kind,
        status: update.status ?? tool.status,
        content: update.content ?? tool.content,
        pendingPermission: pendingPermission ?? tool.pendingPermission,
        location: primaryLocation(update.locations) ?? tool.location,
      }),
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
    pendingPermission,
    location: primaryLocation(update.locations),
  });
}

export const textOf = (block: ContentBlock): string =>
  block.type === "text" ? block.text : `[${block.type}]`;

/** `session_info_update` is also (unrelatedly) how the bridge announces a
 *  session's auto-generated title — only pull out the AIR extension's
 *  connection/retry status, which lives under a specific `_meta` path (see
 *  `sessionFailureMeta` in the bridge's `session-failure-extension.js`). Only
 *  surfaced at all because AgentClient declares the `jetbrains.air` client
 *  capability at `initialize` — without it the bridge never sends these.
 *  `severity` distinguishes a transient retry notice ("warning", e.g.
 *  "Retrying Claude, attempt 2 of 10") from a real failure ("error", e.g.
 *  hitting a spend/usage limit) — the reducer only turns the latter into a
 *  permanent note, since a status line that's wiped the instant the turn
 *  ends would otherwise show it for a moment and then silently drop it. */
const extractSessionFailure = (
  update: SessionUpdate,
): { title: string; severity: string } | undefined => {
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
  const severity = readNested(
    update._meta,
    "jetbrains",
    "air",
    "sessionFailure",
    "severity",
  );
  return typeof title === "string" && typeof severity === "string"
    ? { title, severity }
    : undefined;
};

const readNested = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const extractAvailableCommands = (update: SessionUpdate) =>
  update.sessionUpdate === "available_commands_update"
    ? update.availableCommands
    : undefined;

const extractConfigOptions = (update: SessionUpdate) =>
  update.sessionUpdate === "config_option_update"
    ? update.configOptions
    : undefined;

const extractUsage = (update: SessionUpdate): UsageUpdate | undefined =>
  update.sessionUpdate === "usage_update" ? update : undefined;
