// A tool call's name in the agent's own terms (e.g. "Bash"), where ACP only
// has a coarse kind. Agents send it each their own way; their kinds move it to
// `_meta.acpcode.toolName` as it arrives (see `AgentKind.mapUpdate`).
import type { SessionUpdate, ToolCallUpdate } from "@agentclientprotocol/sdk";

export const toolNameOf = (call: ToolCallUpdate): string | undefined => {
  const name = (call._meta?.acpcode as { toolName?: unknown } | undefined)
    ?.toolName;
  return typeof name === "string" ? name : undefined;
};

/** `update` with `name` as its tool call's name. */
export const withToolName = <T extends SessionUpdate>(
  update: T,
  name: string,
): T => ({
  ...update,
  _meta: {
    ...update._meta,
    acpcode: { ...(update._meta?.acpcode as object), toolName: name },
  },
});
