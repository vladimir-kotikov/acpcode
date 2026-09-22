import { html } from "htm/preact";
import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";

interface CollapsibleStepProps {
  class?: string;
  defaultOpen?: boolean;
  title?: string;
  header: VNode | (VNode | null)[];
  children?: VNode | (VNode | null)[];
}

/** A transcript step that discloses more on demand — always a native
 *  `<details>/<summary>`, no other mode. Knows nothing about tool calls,
 *  ACP, or any other data model, only "a header row plus a disclosure
 *  around some children"; `ToolStep`/`ThoughtStep` (and the "Completed N
 *  steps" fold group) build their own domain-aware header content and pass
 *  it in. A step with nothing to disclose is `StaticStep`, not this
 *  component with empty children — see its own doc comment.
 *
 *  `defaultOpen` forces the step open on the transition into `true`, but
 *  never forces it closed again on the transition back to `false` — so a
 *  user who's manually collapsed it back doesn't get fought on every
 *  unrelated re-render (e.g. the status text updating). This only re-fires
 *  on an actual `true`/`false` flip, not every render, which matters
 *  because the item behind a step is a stable, in-place-updated object: a
 *  step can mount standalone *before* its permission request exists
 *  (`defaultOpen` false at mount, e.g. it has no foldable siblings to be
 *  grouped with) and then have one attached later via the same key/tree
 *  position — no remount, so a mount-only effect would never see that
 *  transition and the step would stay collapsed with its prompt hidden. */
export const CollapsibleStep = ({
  class: className = "",
  defaultOpen,
  title,
  header,
  children,
}: CollapsibleStepProps) => {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (defaultOpen && ref.current) {
      ref.current.open = true;
    }
  }, [defaultOpen]);

  return html`
    <details class="step ${className}" ref=${ref} title=${title}>
      <summary class="step-header">${header}</summary>
      ${children}
    </details>
  `;
};
