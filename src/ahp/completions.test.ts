// node --test src/ahp/completions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandItems,
  fileItems,
  mentionToken,
  slashToken,
} from "./completions.ts";

test("a slash command is only the input's first word", () => {
  assert.deepEqual(slashToken("/com", 4), {
    typed: "com",
    rangeStart: 0,
    rangeEnd: 4,
  });
  assert.equal(slashToken("  /com", 6)?.rangeStart, 2);
  assert.equal(slashToken("/compact now", 12), undefined);
  assert.equal(slashToken("see /com", 8), undefined);
});

test("mentions start after whitespace and end at the cursor", () => {
  assert.deepEqual(mentionToken("look at @src/ma", 15), {
    trigger: "@",
    typed: "src/ma",
    rangeStart: 8,
    rangeEnd: 15,
  });
  assert.equal(mentionToken("#ext", 4)?.trigger, "#");
  assert.equal(mentionToken("mail@host", 9), undefined);
  assert.equal(mentionToken("@a b", 4), undefined);
});

test("commands match by prefix and carry VS Code's command meta", () => {
  const items = commandItems(
    [
      { name: "compact", description: "Compact", input: { hint: "focus" } },
      { name: "clear", description: "Clear" },
    ],
    { typed: "com", rangeStart: 0, rangeEnd: 4 },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].insertText, "/compact ");
  assert.deepEqual(items[0].attachment._meta, {
    command: "compact",
    description: "Compact",
    argumentHint: "focus",
  });
});

test("files rank basename prefix, then basename, then path", () => {
  const items = fileItems(
    "/repo",
    ["docs/readme-main.md", "src/main.ts", "main/x.ts", "src/domain.ts"],
    { trigger: "@", typed: "main", rangeStart: 0, rangeEnd: 5 },
  );
  assert.deepEqual(
    items.map(i => i.attachment.label),
    ["src/main.ts", "src/domain.ts", "docs/readme-main.md", "main/x.ts"],
  );
  assert.equal(items[0].insertText, "@main.ts");
  assert.equal(
    (items[0].attachment as { uri: string }).uri,
    "file:///repo/src/main.ts",
  );
});
