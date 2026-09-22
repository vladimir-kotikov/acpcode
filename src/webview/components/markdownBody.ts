import hljs from "highlight.js";
import { html } from "htm/preact";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "preact/hooks";

marked.setOptions({ breaks: true });

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

interface MarkdownBodyProps {
  text: string;
  class: string;
}

/** Renders markdown for agent, thought, and user text alike; re-parses the
 *  full accumulated text on every chunk rather than appending
 *  incrementally, since a streamed chunk boundary can land mid-markdown-
 *  construct (e.g. inside a ```` ``` ```` fence). Safe against injected
 *  HTML because the page's CSP has no `unsafe-inline` in `script-src`, so
 *  any `<script>`/`onerror=` markup `marked` emits is inert. hljs/copy-
 *  button setup runs as a DOM side effect after each render since it must
 *  mutate real nodes the innerHTML produced, which Preact's diffing
 *  doesn't reach into. */
export const MarkdownBody = ({ text, class: className }: MarkdownBodyProps) => {
  const ref = useRef<HTMLDivElement>(null);
  // MarkdownBody isn't memo()-wrapped, so it re-renders on every unrelated
  // Transcript update (a sibling bubble streaming, busy/statusText
  // toggling) — memoized here so re-parsing only happens when this
  // instance's own text actually changes, not on every cascade.
  const rendered = useMemo(
    () => marked.parse(text, { async: false }) as string,
    [text],
  );
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLPreElement>("pre").forEach(addCopyButton);
    ref.current
      ?.querySelectorAll<HTMLElement>("pre code")
      .forEach(hljs.highlightElement);
  }, [rendered]);

  return html`<div
    class="markdown-body ${className}"
    ref=${ref}
    dangerouslySetInnerHTML=${{ __html: rendered }}
  ></div>`;
};
