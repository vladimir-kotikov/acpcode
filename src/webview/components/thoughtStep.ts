import { html } from "htm/preact";
import type { TextItem } from "../state.ts";
import { CollapsibleStep } from "./collapsibleStep.ts";
import { MarkdownBody } from "./markdownBody.ts";

// Reasoning/scratch output — collapsed by default like a tool call, never
// forced open (thoughts don't need approval).
export const ThoughtStep = ({ item }: { item: TextItem }) =>
  html`<${CollapsibleStep} class="step-thought" header="Thought">
    <${MarkdownBody} text=${item.text} class="bubble bubble-thought" />
  <//>`;
