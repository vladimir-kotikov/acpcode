// Claude Code, through claude-agent-acp.
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { removeClaudeJob, sessionOwner } from "../claudeJobs.ts";
import { plainForm, withFreeText } from "../forms.ts";
import { withToolName } from "../toolNames.ts";
import type { AgentKind } from "./kinds.ts";

/** The fallback for a compaction the client's compaction mapping never sees:
 *  Claude Code keeps the summary as a user message, and a bridge that doesn't
 *  map it to a compaction replays it as one, a huge prompt nobody typed. It's
 *  shown as the completed "Compact conversation" tool call instead.
 *  claude-agent-acp 0.100.0 needs this: it only recognises an older framing
 *  of the summary. Once it maps the summary, it no longer arrives as a user
 *  message. */
// ponytail: the record's `isCompactSummary` doesn't reach ACP, so this
// matches Claude Code's framing, and a prompt pasted with it shows as a card
// too.
const COMPACT_SUMMARY =
  /^\s*This session is being continued from a previous conversation[^\n]*\n[\s\S]*?^Summary:/m;
function compactSummaryAsToolCall(update: SessionUpdate): SessionUpdate {
  if (
    update.sessionUpdate !== "user_message_chunk" ||
    update.content.type !== "text" ||
    !COMPACT_SUMMARY.test(update.content.text)
  ) {
    return update;
  }
  return withToolName(
    {
      sessionUpdate: "tool_call",
      toolCallId: update.messageId ?? randomUUID(),
      title: "Compact conversation",
      kind: "think",
      status: "completed",
      // VS Code Chat only shows a tool call's output when it has input.
      rawInput: {},
      content: [{ type: "content", content: update.content }],
    },
    "compact",
  );
}

/** claude-agent-acp sends its tool's name in `_meta.claudeCode.toolName`. */
function withClaudeToolName(update: SessionUpdate): SessionUpdate {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return update;
  }
  const name = (update._meta?.claudeCode as { toolName?: unknown } | undefined)
    ?.toolName;
  return typeof name === "string" ? withToolName(update, name) : update;
}

export const claude: AgentKind = {
  label: "Claude",
  description: "Spawns @agentclientprotocol/claude-agent-acp",
  bridge: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    binName: "claude-agent-acp",
    cli: "claude",
    cliEnv: "CLAUDE_CODE_EXECUTABLE",
    // Where `claude migrate-installer` puts it.
    cliDirs: [path.join(os.homedir(), ".claude", "local")],
  },
  permissionsKey: "permissionMode",
  resetCommand: {
    name: "clear",
    description: "Clear conversation history and free up context",
  },
  mapUpdate: update => withClaudeToolName(compactSummaryAsToolCall(update)),
  // AskUserQuestion's form follows each select with a `<key>_custom` box for
  // its "Other" answer.
  formOf: request =>
    withFreeText(plainForm(request), select => `${select.key}_custom`),
  sessionOwner,
  removeJob: removeClaudeJob,
};
