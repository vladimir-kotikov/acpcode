import {
  AvailableCommand,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ViewState } from "../state.ts";

// Which config options get a chip, in the order they're shown. "mode" is the
// session permission/approval mode (claude-agent-acp's "Ask Before Edits"
// equivalent) — leftmost, matching where VS Code's own chat composer puts it.
// Deliberately a fixed list rather than "every option the agent sends": the
// agent also exposes `model_config` ones (Fast mode, Agent) that would crowd
// the row, and boolean options have no value list for ConfigChip to show.
const CHIP_CATEGORIES = ["mode", "model", "thought_level"];

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

function selectedOptionLabel(option: SessionConfigOption): string {
  if (option.type !== "select") {
    return option.name;
  }
  return (
    flattenSelectOptions(option.options).find(
      o => o.value === option.currentValue,
    )?.name ?? option.name
  );
}

// A chip for one select-type config option (see CHIP_CATEGORIES) — click to
// open a dropdown of its possible values, matching VS Code's own chat view
// model/mode picker. Boolean-typed options have no value list to pick from,
// so they're not worth a chip here.
interface ConfigChipProps {
  option: SessionConfigOption;
  disabled: boolean;
  onSelect: (configId: string, value: string) => void;
}

function ConfigChip({ option, disabled, onSelect }: ConfigChipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Closes on any click outside the chip — without this, picking a model
  // then clicking into the textarea to type would leave the dropdown
  // floating over the composer.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocMouseDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  if (option.type !== "select") {
    return null;
  }
  const values = flattenSelectOptions(option.options);

  return html`
    <div class="config-chip-wrap" ref=${wrapRef}>
      <button
        type="button"
        class="config-chip"
        disabled=${disabled}
        onClick=${() => setOpen(o => !o)}
      >
        ${selectedOptionLabel(option)}
      </button>
      ${
        open
          ? html`<div class="config-chip-menu">
              ${values.map(
                value => html`
                  <button
                    key=${value.value}
                    type="button"
                    class="config-chip-menu-item ${
                      value.value === option.currentValue
                        ? "config-chip-menu-item-selected"
                        : ""
                    }"
                    onClick=${() => {
                      setOpen(false);
                      if (value.value !== option.currentValue) {
                        onSelect(option.id, value.value);
                      }
                    }}
                  >
                    ${value.name}
                  </button>
                `,
              )}
            </div>`
          : null
      }
    </div>
  `;
}

// Only while the whole message is still just "/" + a bare command name (no
// space yet) — once a space appears the user's typing the command's
// arguments, not still choosing which command, so the popup should be gone.
const matchSlashCommand = (text: string): string | undefined => {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1] : undefined;
};

/** True if every character of `query` appears in `target`, in order (not
 *  necessarily contiguous) — same idea as VS Code's own command-palette/quick-
 *  open matching, just without the match-position highlighting. */
const fuzzyMatches = (query: string, target: string): boolean => {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++;
    }
  }
  return qi === query.length;
};

interface SlashCommandsMenuProps {
  commands: AvailableCommand[];
  selectedIndex: number;
  onSelect: (command: AvailableCommand) => void;
}

const SlashCommandMenu = ({
  commands,
  selectedIndex,
  onSelect,
}: SlashCommandsMenuProps) => html`
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

const SendIcon = () =>
  html`<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 2 13 8H10V14H6V8H3Z" />
  </svg>`;

const StopIcon = () =>
  html`<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>`;

interface ComposerProps {
  state: ViewState;
  onSend: (text: string) => void;
  onCancel: () => void;
  onDraftChange: (text: string) => void;
  onSetConfigOption: (configId: string, value: string | boolean) => void;
}

export const Composer = ({
  state,
  onSend,
  onCancel,
  onDraftChange,
  onSetConfigOption,
}: ComposerProps) => {
  const disabled = !state.meta;
  const chipOptions = CHIP_CATEGORIES.map(category =>
    findConfigOption(state.configOptions, category),
  ).filter((option): option is SessionConfigOption => option !== undefined);
  // Sending mid-turn ("steering") only works when the connected agent
  // implements `_session/steering` — without it, a second `session/prompt`
  // would interrupt the running turn instead of injecting into it, so fall
  // back to the old block-until-idle behavior for agents that don't.
  const steeringBlocked = state.busy && !state.meta?.canSteer;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Shell-style history recall (Up/Down): sourced straight from the
  // transcript's own user blocks rather than a separately tracked list, so
  // it can't drift from what was actually sent. `historyIndex` undefined
  // means "not currently recalling" — `pendingDraft` is whatever was being
  // typed right before the first ArrowUp, restored once Down walks back past
  // the newest entry.
  const promptHistory = state.blocks.flatMap(block =>
    block.type === "user" ? [block.text] : [],
  );
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(
    undefined,
  );
  const [pendingDraft, setPendingDraft] = useState<string | undefined>(
    undefined,
  );
  // A session switch invalidates both: `promptHistory` is now a different
  // list entirely, and any `pendingDraft` belonged to the old session's
  // composer.
  useEffect(() => {
    setHistoryIndex(undefined);
    setPendingDraft(undefined);
  }, [state.meta?.sessionId]);

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
    setHistoryIndex(undefined);
    setPendingDraft(undefined);
  }

  function selectCommand(command: AvailableCommand): void {
    onDraftChange(`/${command.name} `);
    textareaRef.current?.focus();
  }

  // ArrowUp/Down walk `promptHistory` like a shell. Up only *starts* recall
  // when the caret sits at the very beginning — anywhere else it's ordinary
  // cursor movement (e.g. up a line in a multi-line draft); once recall is
  // underway, further Up/Down ignores caret position, same simplification
  // most chat composers make. Down past the newest entry restores whatever
  // was being typed before Up was first pressed.
  function recallHistory(direction: "older" | "newer"): boolean {
    if (direction === "older") {
      if (historyIndex === undefined) {
        const el = textareaRef.current;
        const atStart =
          !!el && el.selectionStart === 0 && el.selectionEnd === 0;
        if (!atStart || promptHistory.length === 0) {
          return false;
        }
        setPendingDraft(state.draftText);
        const nextIndex = promptHistory.length - 1;
        setHistoryIndex(nextIndex);
        onDraftChange(promptHistory[nextIndex]);
        return true;
      }
      const nextIndex = Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      onDraftChange(promptHistory[nextIndex]);
      return true;
    }
    if (historyIndex === undefined) {
      return false;
    }
    const nextIndex = historyIndex + 1;
    if (nextIndex >= promptHistory.length) {
      setHistoryIndex(undefined);
      onDraftChange(pendingDraft ?? "");
      setPendingDraft(undefined);
    } else {
      setHistoryIndex(nextIndex);
      onDraftChange(promptHistory[nextIndex]);
    }
    return true;
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
        onInput=${(event: Event) => {
          onDraftChange((event.target as HTMLTextAreaElement).value);
          // Real typing, not our own recall — leaves the recalled slot
          // behind instead of letting a later Up/Down resume from it.
          setHistoryIndex(undefined);
          setPendingDraft(undefined);
        }}
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
          if (event.key === "ArrowUp" && recallHistory("older")) {
            event.preventDefault();
            return;
          }
          if (event.key === "ArrowDown" && recallHistory("newer")) {
            event.preventDefault();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      ></textarea>
      <div class="input-toolbar">
        <div class="config-chips">
          ${chipOptions.map(
            option =>
              html`<${ConfigChip}
                key=${option.id}
                option=${option}
                disabled=${disabled}
                onSelect=${onSetConfigOption}
              />`,
          )}
        </div>
        ${(() => {
          // One button instead of two: while busy, it's "Send" (steering)
          // whenever there's actually something typed to inject, otherwise
          // there's nothing useful Send could do — "Stop" is the only
          // meaningful action, so that's what takes over the slot.
          const canSend =
            !disabled && !steeringBlocked && !!state.draftText.trim();
          const showStop = state.busy && !canSend;
          const label = showStop ? "Stop" : "Send";
          return html`<button
            type="button"
            class="send-btn ${showStop ? "cancel-btn" : ""}"
            disabled=${!showStop && !canSend}
            aria-label=${label}
            title=${label}
            onClick=${() => (showStop ? onCancel() : submit())}
          >
            ${showStop ? html`<${StopIcon} />` : html`<${SendIcon} />`}
          </button>`;
        })()}
      </div>
    </div>
  `;
};
