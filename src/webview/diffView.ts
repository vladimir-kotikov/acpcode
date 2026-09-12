import { diffLines } from "diff";
import { html } from "htm/preact";

type DiffLineKind = "add" | "remove" | "context";

interface DiffLine {
  text: string;
  kind: DiffLineKind;
}

interface DiffViewProps {
  path: string;
  oldText: string;
  newText: string;
}

// Real diffs collapse long unchanged spans to a few lines of surrounding
// context (like `git diff -U3`) rather than dumping the whole file — without
// this, a one-line change in a long file would render as a wall of unchanged
// text either side.
const DIFF_CONTEXT_LINES = 3;

const DIFF_LINE_PREFIX: Record<DiffLineKind, string> = {
  add: "+ ",
  remove: "- ",
  context: "  ",
};

function toDiffLines(oldText: string, newText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const change of diffLines(oldText, newText)) {
    const kind: DiffLineKind = change.added
      ? "add"
      : change.removed
        ? "remove"
        : "context";
    const chunkLines = change.value.split("\n");
    // diffLines' value always ends with "\n" except possibly the very last
    // chunk of the whole diff - drop the empty string that split() leaves.
    if (chunkLines[chunkLines.length - 1] === "") {
      chunkLines.pop();
    }
    for (const text of chunkLines) {
      lines.push({ text, kind });
    }
  }
  return lines;
}

function windowDiffContext(
  lines: DiffLine[],
): (DiffLine | { kind: "ellipsis" })[] {
  const result: (DiffLine | { kind: "ellipsis" })[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "context") {
      result.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === "context") {
      j++;
    }
    const keepBefore = i === 0 ? 0 : DIFF_CONTEXT_LINES;
    const keepAfter = j === lines.length ? 0 : DIFF_CONTEXT_LINES;
    if (j - i <= keepBefore + keepAfter) {
      result.push(...lines.slice(i, j));
    } else {
      result.push(...lines.slice(i, i + keepBefore));
      result.push({ kind: "ellipsis" });
      result.push(...lines.slice(j - keepAfter, j));
    }
    i = j;
  }
  return result;
}

export const DiffView = ({ oldText, newText }: DiffViewProps) => {
  const lines = windowDiffContext(toDiffLines(oldText, newText));
  // No whitespace between <pre> and the mapped lines: <pre> preserves it
  // literally, and a stray indentation/newline text node here would show up
  // as a visible blank line.
  return html`<div class="tool-diff">
    <pre class="diff-lines">
      ${lines.map((line, index) =>
        line.kind === "ellipsis"
          ? html`<div class="diff-line diff-line-ellipsis" key=${index}>⋯</div>`
          : html`<div class="diff-line diff-line-${line.kind}" key=${index}>
              ${DIFF_LINE_PREFIX[line.kind]}${line.text}
            </div>`,
      )}
  </pre>
  </div>`;
};
