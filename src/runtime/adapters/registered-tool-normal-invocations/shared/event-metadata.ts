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
