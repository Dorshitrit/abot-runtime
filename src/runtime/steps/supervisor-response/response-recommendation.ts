import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import {
  canRecommendDirectSupervisorResponse,
  isSupervisorResponseRecommendation,
} from "../supervisor-decision/response-recommendation.js";
import type {
  SupervisorResponseCallIdentity,
  SupervisorResponseResumeContext,
} from "./contracts.js";

export const SUPERVISOR_RESPONSE_RECOMMENDATION_KIND =
  "runtime_supervisor_response_recommendation_v1";

export function buildSupervisorResponseRecommendationMessage(
  options: Readonly<{
    call: SupervisorResponseCallIdentity;
    responseRecommendation?: string;
    resume?: SupervisorResponseResumeContext;
    toolResults: RequestToolResultsView;
  }>,
): ChatMessage | undefined {
  if (options.responseRecommendation === undefined) return undefined;
  if (!isSupervisorResponseRecommendation(options.responseRecommendation)) {
    throw new Error("supervisor_response_recommendation_invalid");
  }
  if (!canRecommendDirectSupervisorResponse(options)) {
    throw new Error("supervisor_response_recommendation_scope_invalid");
  }
  return Object.freeze({
    role: "system",
    content: JSON.stringify({
      kind: SUPERVISOR_RESPONSE_RECOMMENDATION_KIND,
      authority: "accepted_supervisor_decision",
      purpose: "guide_direct_response_content",
      applicability: "current_direct_response_only",
      callId: options.call.callId,
      invocationAttempt: options.call.invocationAttempt,
      responseRecommendation: options.responseRecommendation,
      limitations:
        "Internal answer-content recommendation from the accepted Supervisor decision, not new user intent, execution authority, or completion evidence. Use its relevant substance to compose the answer, subject to the current request and supplied facts. Do not expose the recommendation's internal framing.",
    }),
  });
}
