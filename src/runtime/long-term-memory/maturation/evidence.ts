import { createHash } from "node:crypto";
import { bindObservationSource } from "../observation-source.js";
import type {
  ApplyLearningDecisionsInput,
  LearningMemoryDecision,
} from "./contracts.js";
import type {
  LearningMemorySource,
  LearningReinforcement,
} from "./evidence-contracts.js";
import { isScheduledKnowledgeReview } from "./scheduled-review.js";

export const MINIMUM_MEMORY_REINFORCEMENTS = 2;

export function bindLearningMemorySource(
  input: ApplyLearningDecisionsInput,
  decision: LearningMemoryDecision,
): LearningMemorySource | undefined {
  if (isScheduledKnowledgeReview(input.cause)) return undefined;
  if (input.cause?.kind !== "conversation_memory_review")
    return bindObservationSource({ ...input, proposals: [] }, decision);
  return {
    kind: "passive_response",
    ...input.cause.evidence,
    reason: decision.reason,
    certainty: decision.certainty,
  };
}

/** A previously seen source cannot count as another opportunity. */
export function advanceLearningReinforcements(
  previous: readonly LearningReinforcement[] = [],
  source: LearningMemorySource | undefined,
  reinforced: boolean,
  now: number,
): readonly LearningReinforcement[] {
  if (!source || !reinforced) return previous;
  const key = learningEvidenceKey(source);
  if (previous.some((entry) => entry.key === key)) return previous;
  const timestamp = Date.parse(source.observedAt);
  if (!Number.isFinite(timestamp) || timestamp > now) return previous;
  return [...previous, { key, observedAt: source.observedAt }].slice(
    -MINIMUM_MEMORY_REINFORCEMENTS,
  );
}

export function hasIndependentLearningEvidence(
  evidence: readonly LearningReinforcement[],
): boolean {
  return evidence.length >= MINIMUM_MEMORY_REINFORCEMENTS;
}

function learningEvidenceKey(source: LearningMemorySource): string {
  const binding =
    source.kind === "passive_response"
      ? [source.kind, source.sourceSessionId, source.evidenceDigest]
      : [
          source.kind,
          source.environmentId,
          source.deviceId,
          [...source.observationIds].sort(),
        ];
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}
