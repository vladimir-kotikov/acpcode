// node --test src/ahp/rowStatus.test.ts
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { SessionStatus } from "@microsoft/agent-host-protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import { rowStatus } from "./acpBridge.ts";

const row = (air?: object): SessionInfo => ({
  sessionId: "s",
  cwd: "/w",
  _meta: air && { jetbrains: { air: { version: 1, ...air } } },
});

test("a row without index metadata is idle", () => {
  assert.equal(rowStatus(row()), SessionStatus.Idle);
});

test("the bridge's activity states map to session statuses", () => {
  assert.equal(rowStatus(row({ state: "idle" })), SessionStatus.Idle);
  assert.equal(rowStatus(row({ state: "running" })), SessionStatus.InProgress);
  assert.equal(rowStatus(row({ state: "error" })), SessionStatus.Error);
  assert.equal(
    rowStatus(row({ state: "requires_action" })),
    SessionStatus.InputNeeded,
  );
});

test("an archived row keeps its state and gains the archived flag", () => {
  assert.equal(
    rowStatus(row({ state: "running", archived: true })),
    SessionStatus.InProgress | SessionStatus.IsArchived,
  );
  assert.equal(rowStatus(row({ archived: false })), SessionStatus.Idle);
});
