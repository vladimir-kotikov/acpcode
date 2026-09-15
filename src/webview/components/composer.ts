import { AvailableCommand } from "@agentclientprotocol/sdk";
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ViewState } from "../state.ts";

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
}

export const Composer = ({
  state,
  onSend,
  onCancel,
  onDraftChange,
}: ComposerProps) => {
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
};
