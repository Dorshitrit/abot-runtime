import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
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
    responseRecommendationOrigin?: "skill_authoring_no_save";
    resume?: SupervisorResponseResumeContext;
    toolResults: RequestToolResultsView;
    skillReadHead?: RoleCallLedgerHead;
  }>,
): ChatMessage | undefined {
  if (options.responseRecommendation === undefined) return undefined;
  if (!isSupervisorResponseRecommendation(options.responseRecommendation)) {
    throw new Error("supervisor_response_recommendation_invalid");
  }
  if (!canProjectSupervisorResponseRecommendation(options)) {
    throw new Error("supervisor_response_recommendation_scope_invalid");
  }
  const { limitations, ...semantics } = supervisorResponseRecommendationSemantics(options.responseRecommendationOrigin);
  return Object.freeze({
    role: "system",
    content: JSON.stringify({
      kind: SUPERVISOR_RESPONSE_RECOMMENDATION_KIND,
      authority: "accepted_supervisor_decision",
      ...semantics,
      callId: options.call.callId,
      invocationAttempt: options.call.invocationAttempt,
      responseRecommendation: options.responseRecommendation,
      limitations,
    }),
  });
}

function canProjectSupervisorResponseRecommendation(
  options: Parameters<typeof canRecommendDirectSupervisorResponse>[0] & {
    responseRecommendationOrigin?: "skill_authoring_no_save";
  },
): boolean {
  if (options.responseRecommendationOrigin === "skill_authoring_no_save") return true;
  return canRecommendDirectSupervisorResponse(options);
}

function supervisorResponseRecommendationSemantics(
  origin: "skill_authoring_no_save" | undefined,
) {
  if (origin === "skill_authoring_no_save") {
    return {
      purpose: "explain_skill_authoring_no_save",
      applicability: "current_response_after_skill_authoring_no_save",
      outcome: "no_save",
      limitations:
        "The accepted Skill authoring flow did not produce a save. Use the supplied reason to explain why, subject to the current request and supplied facts. It adds no user intent, execution authority, or completion evidence. This decision does not establish a save; report any earlier save only from its confirmed write result. Do not expose internal routing details.",
    };
  }
  return {
    purpose: "guide_direct_response_content",
    applicability: "current_direct_response_only",
    limitations:
      "Internal answer-content recommendation from the accepted Supervisor decision, not new user intent, execution authority, or completion evidence. Use its relevant substance to compose the answer, subject to the current request and supplied facts. Do not expose the recommendation's internal framing.",
  };
}
