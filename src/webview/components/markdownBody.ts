import hljs from "highlight.js";
import { html } from "htm/preact";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { CHECK_ICON_SVG, COPY_ICON_SVG } from "./preBlock.ts";

marked.setOptions({ breaks: true });

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
