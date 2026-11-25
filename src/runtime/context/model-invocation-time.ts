import { markInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  captureRequestTemporalContext,
  REQUEST_TEMPORAL_CONTEXT_MESSAGE_KIND,
} from "./request-temporal-context.js";

/** An invocation-local clock observation, separate from the request's relative-time anchor. */
export function captureModelInvocationTimeMessage(timeZone?: string): ChatMessage {
  const observation = captureRequestTemporalContext({ timeZone });
  return markInvocationContextMessage({
    role: "system",
    content: JSON.stringify({
      kind: "runtime_invocation_time_v1",
      authority: "runtime_server_clock",
      purpose: "current_time_at_model_invocation_preparation",
      currentDateTime: observation.currentDateTime,
      timeZone: observation.timeZone,
      requestTimeReference: REQUEST_TEMPORAL_CONTEXT_MESSAGE_KIND,
      passive: "does_not_replace_request_time_or_add_user_intent_permissions_or_completion_evidence",
    }),
  });
}
