// node --test src/ahp/server.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { negotiate } from "./server.ts";

test("the negotiated protocol version is always one the client offered", () => {
  assert.equal(negotiate(["1.1.0", "1.0.0", "0.10.0"]), "1.0.0");
  assert.equal(negotiate(["1.2.0", "1.1.3", "1.1.10"]), "1.1.3");
  assert.equal(negotiate(["0.9.0", "1.2.0"]), "1.2.0");
  assert.equal(negotiate(["1.0.0-beta", "1.0", "1.3.0"]), "1.3.0");
  assert.equal(negotiate(["2.0.0", "0.9.0"]), undefined);
  assert.equal(negotiate([]), undefined);
});
