import type { ObservationMemorySource } from "../observation-contracts.js";
import type { ApplyLearningDecisionsInput, LearningCandidateRecord, LearningMemoryDecision } from "./contracts.js";
import { isScheduledKnowledgeReview } from "./scheduled-review.js";
import type { LearningMemorySource, LearningReinforcement } from "./evidence-contracts.js";
import { hasIndependentLearningEvidence } from "./evidence.js";

/** Semantic reinforcement still requires a new, bound source before it has durable effects. */
export function hasFreshCandidateReinforcement(options: {
  previous: LearningCandidateRecord | undefined;
  decision: LearningMemoryDecision;
  input: ApplyLearningDecisionsInput;
  source: LearningMemorySource | undefined;
  mergedSources: readonly LearningMemorySource[];
}): boolean {
  const { previous, decision, input, source, mergedSources } = options;
  const initialAssessedEvidence = decision.action === "create" && decision.score > 0;
  if (!decision.reinforced && !initialAssessedEvidence) return false;
  if (isScheduledKnowledgeReview(input.cause)) return false;
  if (!source) return false;
  const sources = [...(previous?.sources ?? []), ...mergedSources];
  if (source.kind === "passive_response") return !sources.some(earlier =>
    earlier.kind === "passive_response" && (earlier.sourceRequestId === source.sourceRequestId || earlier.evidenceDigest === source.evidenceDigest));
  const history = sources.filter((earlier): earlier is ObservationMemorySource =>
    earlier.kind === "passive_observation" && sharesObservationOrigin(earlier, source));
  if (history.some(earlier => earlier.batchId === source.batchId)) return false;
  const knownIds = new Set(history.flatMap(earlier => earlier.observationIds));
  return input.observations.some(observation => isFreshCitedObservation(observation, source, knownIds));
}

/** Even a high-scoring first decision must be persisted as a candidate. */
export function canPromoteLearningCandidate(
  previous: LearningCandidateRecord | undefined,
  decision: LearningMemoryDecision,
  input: ApplyLearningDecisionsInput,
  reinforced: boolean,
  evidence: readonly LearningReinforcement[] = [],
): boolean {
  if (!previous) return false;
  if (isScheduledKnowledgeReview(input.cause)) return false;
  if (!reinforced) return false;
  if (!hasIndependentLearningEvidence(evidence)) return false;
  return decision.score >= input.policy.promotionScore;
}

function sharesObservationOrigin(earlier: ObservationMemorySource, current: ObservationMemorySource): boolean {
  if (earlier.environmentId !== current.environmentId) return false;
  return earlier.deviceId === current.deviceId;
}

function isFreshCitedObservation(
  observation: ApplyLearningDecisionsInput["observations"][number],
  source: ObservationMemorySource,
  knownIds: ReadonlySet<string>,
): boolean {
  if (!source.observationIds.includes(observation.id)) return false;
  if (observation.deviceId !== source.deviceId) return false;
  if (knownIds.has(observation.id)) return false;
  if (observation.revisitsObservationId) return false;
  if (observation.revisit?.contentUnchanged) return false;
  return true;
}
