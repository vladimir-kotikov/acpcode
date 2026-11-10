// A scripted ACP agent bridge for tests: `client.connect(agent,
// fakeAgent(t, handle))` spawns it in place of the real bridge. It answers
// `initialize` itself, advertising `agentCapabilities`, and hands every
// JSON-RPC message to `handle` (`initialize` too, after answering it),
// which runs in the child process — so it must be self-contained, with no
// closure over the test's variables.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
}

export function fakeAgent(
  t: TestContext,
  handle: (message: RpcMessage, send: (message: RpcMessage) => void) => void,
  agentCapabilities: object = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "agent.mjs");
  fs.writeFileSync(
    script,
    `import * as readline from "node:readline";
const send = message =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const handle = ${handle.toString()};
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: ${JSON.stringify(agentCapabilities)} } });
  }
  handle(message, send);
});
`,
  );
  return script;
}
