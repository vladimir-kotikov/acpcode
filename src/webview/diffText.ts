import { diffLines } from "diff";

type DiffLineKind = "add" | "remove" | "context";

interface DiffLine {
  text: string;
  kind: DiffLineKind;
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

/** Unified-diff *text* (the "+ "/"- "/"  " prefixes hljs's `diff` grammar
 *  keys off), context-windowed like `git diff -U3` — not a component, just
 * string-building, so it lives outside components/ and feeds straight into
 *  PreBlock's `syntaxLanguage="diff"` wherever a diff needs rendering. */
export const buildDiffText = (oldText: string, newText: string): string =>
  windowDiffContext(toDiffLines(oldText, newText))
    .map(line =>
      line.kind === "ellipsis"
        ? "..."
        : `${DIFF_LINE_PREFIX[line.kind]}${line.text}`,
    )
    .join("\n");
