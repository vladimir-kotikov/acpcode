// Claude Code, through claude-agent-acp.
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { removeClaudeJob, sessionOwner } from "../claudeJobs.ts";
import { plainForm, withFreeText } from "../forms.ts";
import { withToolMeta } from "../toolMeta.ts";
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
  return withToolMeta(
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
    { toolName: "compact" },
  );
}

/** A command's output, sent without a terminal, comes fenced as Markdown. */
const CONSOLE_FENCE = /^```console\n([\s\S]*)\n```$/;

/** claude-agent-acp's tool call in shared terms. It names the tool in
 *  `_meta.claudeCode.toolName`, and titles a shell command with its command
 *  line: what it's for is the input's `description`, or `command_description`
 *  (CLI 2.1.295 takes either; the first wins). */
function sharedToolCall(update: SessionUpdate): SessionUpdate {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return update;
  }
  const name = (update._meta?.claudeCode as { toolName?: unknown } | undefined)
    ?.toolName;
  const input = update.rawInput as
    { description?: unknown; command_description?: unknown } | null | undefined;
  const intention =
    typeof input?.description === "string"
      ? input.description
      : input?.command_description;
  const meta = {
    ...(typeof name === "string" && { toolName: name }),
    ...(typeof intention === "string" && intention && { intention }),
  };
  const content = update.content?.map(item =>
    item.type === "content" && item.content.type === "text"
      ? {
          ...item,
          content: {
            ...item.content,
            text:
              CONSOLE_FENCE.exec(item.content.text)?.[1] ?? item.content.text,
          },
        }
      : item,
  );
  const shared = content ? { ...update, content } : update;
  return Object.keys(meta).length ? withToolMeta(shared, meta) : shared;
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
  mapUpdate: update => sharedToolCall(compactSummaryAsToolCall(update)),
  // AskUserQuestion's form follows each select with a `<key>_custom` box for
  // its "Other" answer.
  formOf: request =>
    withFreeText(plainForm(request), select => `${select.key}_custom`),
  sessionOwner,
  removeJob: removeClaudeJob,
};
