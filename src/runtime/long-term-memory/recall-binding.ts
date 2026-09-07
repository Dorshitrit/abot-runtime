import type { ChatMessage } from "../../model-gateway/types.js";
import { isRecord } from "../validation/strict-record.js";
import { MEMORY_RECALL_REFERENCE_KIND } from "./recall-context.js";

/** Bind every consuming invocation so steering rebuilds context at the root. */
export function resolveMemoryRecallSteeringVersion(
  message: ChatMessage | undefined,
  requestId: string,
  callId: string,
): number | undefined {
  if (!message) return undefined;
  const reference: unknown = JSON.parse(message.content);
  if (!hasMemoryRecallBinding(reference, requestId, callId)) {
    throw new Error("memory_recall_context_binding_invalid");
  }
  return reference.steeringVersion;
}

function hasMemoryRecallBinding(
  value: unknown,
  requestId: string,
  callId: string,
): value is { steeringVersion: number } {
  if (!isRecord(value)) return false;
  if (value.kind !== MEMORY_RECALL_REFERENCE_KIND) return false;
  if (value.authority !== "passive_reference") return false;
  if (value.requestId !== requestId) return false;
  if (value.callId !== callId) return false;
  if (!Number.isSafeInteger(value.steeringVersion)) return false;
  return (value.steeringVersion as number) >= 0;
}
