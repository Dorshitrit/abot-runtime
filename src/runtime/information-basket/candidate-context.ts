import type { ChatMessage } from "../../model-gateway/types.js";
import type { projectRequestContext } from "../context/request-context.js";
import { resolveCapabilityBriefHeadroom } from "../context/capability-brief-budget.js";
import { estimateMessageTokens } from "../context/token-estimator.js";
import type { ModelStepOptionalContextProjection } from "../model/model-step-port.js";
import type { RequestBasketCandidates } from "./request-candidates.js";

export const INFORMATION_BASKET_CANDIDATES_KIND = "runtime_information_basket_candidates_v1";
export const INFORMATION_BASKET_CANDIDATE_MAX_TOKENS = 512;

export type BasketCandidateProjection = Readonly<{
  message: ChatMessage;
  remove: ModelStepOptionalContextProjection;
}>;

/** Discovery yields to every existing input; selected reads use ordinary evidence instead. */
export function projectInformationBasketCandidates(params: Readonly<{
  snapshot?: RequestBasketCandidates;
  context: Parameters<typeof projectRequestContext>[0];
  additionalBudgetMessages?: readonly ChatMessage[];
}>): BasketCandidateProjection | undefined {
  const { snapshot, context } = params;
  if (!snapshot || snapshot.result.sources.length === 0) return undefined;
  const headroom = Math.min(INFORMATION_BASKET_CANDIDATE_MAX_TOKENS,
    resolveCapabilityBriefHeadroom({
      context, additionalBudgetMessages: params.additionalBudgetMessages,
    }));
  if (headroom <= 0) return undefined;
  const base = {
    kind: INFORMATION_BASKET_CANDIDATES_KIND,
    authority: "passive_reference",
    source: "information_basket_ready_index",
    purpose: "optional_source_discovery",
    applicability: "current_request_decision_only",
    presenceEffect: "no_new_intent_assignment_permission_work_or_evidence",
    selection: "Optional matches; explicit targets prevail. No automatic source or Skill reads.",
    requestId: snapshot.requestId,
    steeringVersion: snapshot.steeringVersion,
    discoveryRevision: snapshot.discoveryRevision,
    relevantSourceCount: snapshot.result.sources.length,
    omittedCount: snapshot.result.omittedCount,
  };
  const sources: Readonly<Record<string, unknown>>[] = [];
  let message: ChatMessage | undefined;
  const candidates = snapshot.result.sources;
  for (const candidate of candidates) {
    const entry = {
      sourceId: candidate.sourceId,
      expectedRevision: candidate.expectedRevision,
      displayName: candidate.displayName.slice(0, 120),
    };
    const next = candidateMessage({
      ...base, metadataMayBeShortened: true,
      omittedCount: snapshot.result.omittedCount + candidates.length - sources.length - 1,
      sources: [...sources, entry],
    });
    if (estimateMessageTokens(next, context.budget.tokenEstimation) > headroom) break;
    sources.push(entry);
    message = next;
  }
  if (!message) {
    const countOnly = candidateMessage({
      ...base,
      omittedCount: snapshot.result.omittedCount + candidates.length,
      selection: "Optional matches: search only for a concrete task need. Their presence requires neither source nor Skill reads.",
    });
    if (estimateMessageTokens(countOnly, context.budget.tokenEstimation) > headroom) return undefined;
    message = countOnly;
  }
  const bound = message;
  return Object.freeze({
    message: bound,
    remove(messages) {
      const index = messages.findIndex((candidate) => matchesCandidateMessage(candidate, bound));
      if (index < 0) return messages;
      return messages.filter((_, position) => position !== index);
    },
  });
}

function candidateMessage(value: Readonly<Record<string, unknown>>): ChatMessage {
  return Object.freeze({ role: "assistant", content: JSON.stringify(value) });
}

function matchesCandidateMessage(candidate: ChatMessage, bound: ChatMessage): boolean {
  if (candidate === bound) return true;
  if (candidate.role !== bound.role) return false;
  return candidate.content === bound.content;
}
