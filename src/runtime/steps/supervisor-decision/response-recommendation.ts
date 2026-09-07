import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import type {
  SupervisorRespondDecision,
  SupervisorResumeContext,
  SupervisorRoutingDecision,
} from "./contracts.js";

export const SUPERVISOR_RESPONSE_RECOMMENDATION_MAX_LENGTH = 300;

export function canRecommendDirectSupervisorResponse(
  options: Readonly<{
    resume?: SupervisorResumeContext;
    toolResults: RequestToolResultsView;
  }>,
): boolean {
  if (options.resume !== undefined) return false;
  return options.toolResults.results.length === 0;
}

export function isSupervisorResponseRecommendation(
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  return value.length <= SUPERVISOR_RESPONSE_RECOMMENDATION_MAX_LENGTH;
}

/** Only a supplied advisory key participates in exact response shape checks. */
export function supervisorResponseRecommendationKeys(
  record: Record<string, unknown>,
  enabled: boolean,
): readonly string[] {
  if (!enabled) return [];
  if (!Object.hasOwn(record, "responseRecommendation")) return [];
  return ["responseRecommendation"];
}

/** Advisory content cannot invalidate an otherwise valid routing decision. */
export function projectSupervisorResponseRecommendation(
  value: unknown,
): Pick<SupervisorRespondDecision, "responseRecommendation"> {
  if (!isSupervisorResponseRecommendation(value)) return {};
  return { responseRecommendation: value.trim() };
}

export function supervisorResponseRecommendationLength(
  decision: SupervisorRoutingDecision,
): number {
  if (decision.action !== "respond") return 0;
  return decision.responseRecommendation?.length ?? 0;
}
