import { html } from "htm/preact";
import type { VNode } from "preact";

interface StaticStepProps {
  class?: string;
  title?: string;
  header: VNode | (VNode | null)[];
}

/** A transcript step with nothing to disclose — e.g. a completed read call,
 *  whose only action is "open the file", not "show more detail". One
 *  element, not `CollapsibleStep` wrapped around empty children: `.step`
 *  and `.step-header` (the sizing/overflow and the flex-row/padding/hover
 *  rules, respectively) both land on it directly rather than a `<details>`
 *  wrapping a `<summary>` that would just be the whole step anyway — a
 *  `<details>` with nothing inside it to reveal has no reason to exist. */
export const StaticStep = ({
  class: className = "",
  title,
  header,
}: StaticStepProps) => html`
  <div class="step step-header ${className}" title=${title}>${header}</div>
`;
