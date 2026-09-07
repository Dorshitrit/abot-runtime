import { buildToolStartEventMetadata } from "../../../../capabilities/tool-event-metadata.js";
import type {
  ToolCall,
  ToolDefinition,
} from "../../../../capabilities/tool-types.js";

export function buildToolIntentEventMetadata(
  call: ToolCall,
  intent: string | undefined,
  definition?: ToolDefinition,
): Record<string, unknown> | undefined {
  const metadata = buildToolStartEventMetadata(call, definition);
  if (!intent) return metadata;
  return {
    ...(metadata ?? {}),
    intent,
  };
}

/** Canonical caller identity used only to attribute client lifecycle events. */
export type ToolEventExecutorIdentity = Readonly<{
  callId: string;
  roleId: string;
}>;

export function buildToolExecutorEventMetadata(
  identity: ToolEventExecutorIdentity | undefined,
) {
  if (!identity) return undefined;
  return {
    roleCallId: identity.callId,
    executorRole: identity.roleId,
  };
}
