// node --test src/ahp/hostFiles.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { windowFolders } from "./hostFiles.ts";

test("the most recently focused window's folders come first", () => {
  const windows = [
    { folders: ["/a", "/b"], focusedAt: 100 },
    { folders: ["/c"], focusedAt: 200 },
  ];

  const folders = windowFolders(windows);

  assert.deepEqual(folders, ["/c", "/a", "/b"]);
});

test("a window that never reported focus comes last", () => {
  const windows = [{ folders: ["/old"] }, { folders: ["/new"], focusedAt: 1 }];

  const folders = windowFolders(windows);

  assert.deepEqual(folders, ["/new", "/old"]);
});

test("a folder open in several windows is listed once, at its first place", () => {
  const windows = [
    { folders: ["/shared", "/a"], focusedAt: 100 },
    { folders: ["/b", "/shared"], focusedAt: 200 },
  ];

  const folders = windowFolders(windows);

  assert.deepEqual(folders, ["/b", "/shared", "/a"]);
});

test("no windows means no folders", () => {
  assert.deepEqual(windowFolders([]), []);
});
