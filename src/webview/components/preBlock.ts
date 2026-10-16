import hljs from "highlight.js";
import { html } from "htm/preact";
import { useState } from "preact/hooks";

// Static, trusted markup (not derived from any agent/user data) — safe to
// assign via innerHTML. Exported since MarkdownBody's own copy button (for
// fenced code blocks inside rendered markdown) needs the exact same icons.
export const COPY_ICON_SVG = `<svg class="icon-copy" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5V3a1 1 0 0 1 1-1H11"/></svg>`;
export const CHECK_ICON_SVG = `<svg class="icon-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>`;

// Collapse past this many lines by default, with a "Show more" toggle — full
// tool output (a whole file's contents, a long command's stdout, a big
// diff) can run to thousands of lines.
const PRE_BLOCK_TRUNCATE_LINES = 20;

const CopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);
  return html`<button
    type="button"
    class="code-copy-btn ${copied ? "copied" : ""}"
    aria-label="Copy"
    onClick=${() => {
      void navigator.clipboard.writeText(content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    }}
    dangerouslySetInnerHTML=${{
      __html: COPY_ICON_SVG + CHECK_ICON_SVG,
    }}
  ></button>`;
};

interface PreBlockProps {
  content: string;
  copy?: boolean;
  truncate?: number | false;
  syntaxLanguage?: string;
}

/** One block-of-monospace-text component for every case that used to be its
 *  own bespoke component (a truncated plain-text block, a copyable shell
 *  command, a hand-colored diff) — a `<pre>` with any combination of {copy
 *  button, "Show more"/"Show less" truncation, hljs syntax highlighting}.
 *  Knows nothing about tool calls, diffs, or any other data shape: callers
 *  that need diff coloring build unified-diff *text* (see ../diffText.ts)
 *  and pass `syntaxLanguage="diff"` like any other language. */
export const PreBlock = ({
  content,
  copy = true,
  truncate = PRE_BLOCK_TRUNCATE_LINES,
  syntaxLanguage,
}: PreBlockProps) => {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = truncate && lines.length > truncate;
  const visibleContent =
    expanded || !isLong ? content : lines.slice(0, truncate).join("\n");
  const toggleLabel = expanded ? "Show less" : "...";

  // The truncation ellipsis (or, once expanded, the "Show less" that takes
  // its place) is itself the toggle, inline at the end of the text — reads
  // more naturally than a separate button below the box. Delegated to the
  // <pre> rather than attached directly to the toggle span: the
  // syntax-highlighted branch's span only exists inside
  // dangerouslySetInnerHTML's raw HTML, which Preact never wires a listener
  // onto, but a click on it still bubbles up to the <pre> like any other
  // DOM event.
  const onTogglePre = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest(".pre-toggle")) {
      setExpanded(e => !e);
    }
  };

  const pre = syntaxLanguage
    ? html`<pre
        class="hljs"
        onClick=${isLong ? onTogglePre : undefined}
        dangerouslySetInnerHTML=${{
          __html:
            hljs.highlight(visibleContent, { language: syntaxLanguage }).value +
            (isLong ? `\n<span class="pre-toggle">${toggleLabel}</span>` : ""),
        }}
      ></pre>`
    : // No whitespace between <pre> and the interpolations below — <pre>
      // preserves it literally, and a stray formatting newline here would
      // show up as a visible blank line before/after the real content.
      html`<pre onClick=${isLong ? onTogglePre : undefined}>
        ${visibleContent}${isLong ? "\n" : ""}${isLong ? html`<span class="pre-toggle">${toggleLabel}</span>` : null}
      </pre>`;

  return html`
    <div class="code-block">
      ${pre} ${copy ? html`<${CopyButton} content=${content} />` : null}
    </div>
  `;
};
