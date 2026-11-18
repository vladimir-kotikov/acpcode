// What an agent tells about a tool call beyond ACP's fields, each agent its
// own way; its kind moves it to `_meta.acpcode` as it arrives (see
// `AgentKind.mapUpdate`).
import type { SessionUpdate, ToolCallUpdate } from "@agentclientprotocol/sdk";

export interface ToolMeta {
  /** The agent's own name for the tool (e.g. "Bash"), where ACP only has a
   *  coarse kind. */
  toolName?: string;
  /** What the call is for, in a few words (e.g. "Run the tests"), where its
   *  title may be the command line. */
  intention?: string;
}

export const toolMetaOf = (call: ToolCallUpdate): ToolMeta => {
  const meta = call._meta?.acpcode as Record<string, unknown> | undefined;
  const text = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  return {
    toolName: text(meta?.toolName),
    intention: text(meta?.intention),
  };
};

/** `update` with `meta` added to its tool call's. */
export const withToolMeta = <T extends SessionUpdate>(
  update: T,
  meta: ToolMeta,
): T => ({
  ...update,
  _meta: {
    ...update._meta,
    acpcode: { ...(update._meta?.acpcode as object), ...meta },
  },
});
