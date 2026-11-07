// node --test src/acp/claudeJobs.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { removeClaudeJob } from "./claudeJobs.ts";
import { fakeClaude } from "./fakeClaude.test-util.ts";

const state = (sessionId: string) => JSON.stringify({ sessionId });

test("stops and removes every job running the session, and only those", async t => {
  const claude = fakeClaude(t);
  claude.job("a1", state("session-2"));
  claude.job("b1", state("session-1"));
  claude.job("c1", state("session-1"));
  claude.job("d1", "{"); // mid-write
  claude.job("-rf", state("session-1")); // would read as an option

  await removeClaudeJob(claude.env, "session-1");

  const calls = claude.calls();
  assert.deepEqual(calls.filter(c => c.startsWith("rm")).sort(), [
    "rm b1",
    "rm c1",
  ]);
  assert.equal(calls.length, 4);
  assert.ok(calls.indexOf("stop b1") < calls.indexOf("rm b1"));
  assert.ok(calls.indexOf("stop c1") < calls.indexOf("rm c1"));
});

test("a job that won't stop (it already exited) is still removed", async t => {
  const claude = fakeClaude(t, "stop");
  claude.job("a1", state("session-1"));

  await removeClaudeJob(claude.env, "session-1");

  assert.deepEqual(claude.calls(), ["stop a1", "rm a1"]);
});

test("a refused rm fails with what claude printed", async t => {
  const claude = fakeClaude(t, "rm");
  claude.job("a1", state("session-1"));

  await assert.rejects(removeClaudeJob(claude.env, "session-1"), /refused/);
});

test("a config dir without jobs runs nothing", async t => {
  const claude = fakeClaude(t);

  assert.equal(await removeClaudeJob(claude.env, "session-1"), "");
  assert.deepEqual(claude.calls(), []);
});
