import { isToolResultMedia, type ToolImageEvidence } from "../../capabilities/tool-media.js";
import type { ChatMessage, ModelGatewayAttachment } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import type { RequestToolMediaStore } from "../attachments/request-tool-media.js";

type Evidence = Readonly<{ executionId: string; callId?: string; media: readonly ToolImageEvidence[] }>;

/** Hydrates only exact original evidence in the producing role's existing lane. */
export function projectToolMediaMessages(params: {
  messages: readonly ChatMessage[];
  store?: RequestToolMediaStore;
  modelStep: ModelStep;
  supportsImages: boolean;
}): ChatMessage[] {
  if (!isToolMediaConsumer(params.modelStep)) return [...params.messages];
  return params.messages.map((message) => projectMessage(message, params));
}

function isToolMediaConsumer(step: ModelStep): boolean {
  return ["execution.decision", "execution.response", "worker.decision", "worker.result"].includes(step);
}

function projectMessage(message: ChatMessage, params: Parameters<typeof projectToolMediaMessages>[0]): ChatMessage {
  const content = readRecord(message.content);
  if (!content) return message;
  const evidence = readOriginalEvidence(message, content, params.modelStep);
  if (!evidence.length) return message;
  const mediaDelivery = {
    kind: "runtime_tool_media_delivery_v1",
    authority: "passive_tool_evidence_not_user_intent",
    status: params.supportsImages ? "delivered" : "unsupported_image_input",
    ...(params.supportsImages ? {} : { message: "This model cannot receive the tool images. Image references are not visual evidence; use available text or report this limitation." }),
  };
  const attachments: ModelGatewayAttachment[] = [];
  for (const item of evidence) {
    for (const reference of item.media) {
      if (!params.store) throw new Error("tool_media_store_unavailable");
      const owner = params.store.ownerOf(item.executionId, reference);
      if (item.callId && item.callId !== owner.callId) throw new Error("tool_media_call_mismatch");
      const data = params.store.resolve(owner, reference);
      if (!params.supportsImages) continue;
      attachments.push({
        id: reference.id, kind: "image", mimeType: reference.mimeType,
        storageRef: "request-tool-media", size: reference.size, data,
        toolEvidence: { executionId: item.executionId },
      });
    }
  }
  if (message.toolCalls) throw new Error("tool_media_lane_invalid");
  return {
    ...message,
    content: JSON.stringify({ ...content, mediaDelivery }),
    ...(attachments.length ? { attachments } : {}),
  };
}

function readOriginalEvidence(message: ChatMessage, content: Record<string, unknown>, step: ModelStep): Evidence[] {
  if (message.role === "tool") {
    if (!step.startsWith("execution.")) return [];
    if (content.kind !== "runtime_execution_capability_result_v1") return [];
    const result = record(content.result);
    if (!result || result.executionId !== message.toolCallId) throw new Error("tool_media_result_binding_invalid");
    return readExecutionEvidence(result);
  }
  if (!step.startsWith("worker.") || message.role !== "user") return [];
  if (content.kind !== "runtime_request_tool_results_v1") return [];
  if (!Array.isArray(content.results)) return [];
  return content.results.flatMap((entry) => {
    const result = record(entry);
    return result ? readExecutionEvidence(result) : [];
  });
}

function readExecutionEvidence(result: Record<string, unknown>): Evidence[] {
  const adapter = record(result.adapterResult);
  if (adapter?.kind !== "registered_tool_execution_result_v1") return [];
  const original = record(adapter.result);
  if (!original || original.media === undefined) return [];
  if (!isToolResultMedia(original.media) || typeof result.executionId !== "string")
    throw new Error("tool_media_result_invalid");
  if (!original.media?.length) return [];
  return [{ executionId: result.executionId, ...(typeof result.callId === "string" ? { callId: result.callId } : {}), media: original.media }];
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readRecord(value: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(value)); } catch { return undefined; }
}
