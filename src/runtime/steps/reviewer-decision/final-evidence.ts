import type { ModelTokenEstimationConfig } from "../../../model-gateway/types.js";
import { estimateTextTokens } from "../../context/token-estimator.js";
import type {
  RoleCapabilityObservedEffect,
  RoleCapabilityResultReference,
} from "../../orchestration/role-calls/index.js";
import {
  REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH,
  REVIEWER_ITEM_SUMMARY_MAX_LENGTH,
  REVIEWER_MAX_EVIDENCE,
  type ReviewerEvidence,
} from "./contracts.js";

export type ReviewerReferenceDataBudget = Readonly<{
  maxTokens: number;
  tokenEstimation?: ModelTokenEstimationConfig;
}>;

export type ReviewerEvidenceCandidate = Readonly<{
  executionId: string;
  outcome: "succeeded" | "failed";
  observedEffect: RoleCapabilityObservedEffect;
  summary: string;
  referenceData?: string;
  references?: readonly RoleCapabilityResultReference[];
  subjectRef: string;
}>;

export type ReviewerFinalEvidenceProjection = Readonly<{
  evidence: readonly ReviewerEvidence[];
  projectionComplete: boolean;
  sourceExecutionCount: number;
  supersededExecutionCount: number;
  retainedFailedExecutionCount: number;
  retainedUntargetedExecutionCount: number;
  sourceReferenceDataCount: number;
  sourceReferenceDataChars: number;
  retainedReferenceDataCount: number;
  retainedReferenceDataChars: number;
  omittedReferenceDataCount: number;
  omittedReferenceDataChars: number;
}>;

const REVIEWER_SUMMARY_CONTINUATION_KIND =
  "runtime_reviewer_evidence_summary_continuation_v1" as const;

/**
 * Reduces settled execution history to the current effect for each known
 * logical target. It retains the latest execution, latest state-changing
 * transition, latest successful mutation, all still-current successful
 * observations, and each pinned transition's successful precondition
 * observations. This keeps a bounded transition chain without guessing which
 * same-target observation is authoritative or reusing stale observations.
 * Untargeted executions are retained because no sound supersession identity is
 * available for them.
 */
export function projectReviewerFinalEvidence(
  candidates: readonly ReviewerEvidenceCandidate[],
  referenceDataBudget: ReviewerReferenceDataBudget,
): ReviewerFinalEvidenceProjection {
  const latestIndexByTarget = new Map<string, number>();
  const latestStateChangingIndexByTarget = new Map<string, number>();
  const latestSuccessfulMutationIndexByTarget = new Map<string, number>();
  const successfulObservationIndexesByTarget = new Map<string, number[]>();
  const stateChangingWitnessIndexesByTarget = new Map<
    string,
    readonly number[]
  >();
  const successfulMutationWitnessIndexesByTarget = new Map<
    string,
    readonly number[]
  >();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const targets = new Set(
      (candidate.references ?? []).map(({ target }) => target),
    );
    for (const target of targets) {
      latestIndexByTarget.set(target, index);
      if (
        candidate.observedEffect === "mutation" ||
        candidate.observedEffect === "indeterminate"
      ) {
        const witnessIndexes = successfulObservationIndexesByTarget.get(target);
        latestStateChangingIndexByTarget.set(target, index);
        if (witnessIndexes && witnessIndexes.length > 0) {
          stateChangingWitnessIndexesByTarget.set(target, [...witnessIndexes]);
        } else {
          stateChangingWitnessIndexesByTarget.delete(target);
        }
        if (
          candidate.outcome === "succeeded" &&
          candidate.observedEffect === "mutation"
        ) {
          latestSuccessfulMutationIndexByTarget.set(target, index);
          if (witnessIndexes && witnessIndexes.length > 0) {
            successfulMutationWitnessIndexesByTarget.set(target, [
              ...witnessIndexes,
            ]);
          } else {
            successfulMutationWitnessIndexesByTarget.delete(target);
          }
        }
        successfulObservationIndexesByTarget.delete(target);
      } else if (
        candidate.outcome === "succeeded" &&
        candidate.observedEffect === "observation"
      ) {
        const observationIndexes =
          successfulObservationIndexesByTarget.get(target);
        if (observationIndexes) {
          observationIndexes.push(index);
        } else {
          successfulObservationIndexesByTarget.set(target, [index]);
        }
      }
    }
  }

  const coreIndexSet = new Set([
    ...latestIndexByTarget.values(),
    ...latestStateChangingIndexByTarget.values(),
    ...latestSuccessfulMutationIndexByTarget.values(),
    ...[...successfulObservationIndexesByTarget.values()].flat(),
  ]);
  const preconditionWitnessIndexes = new Set(
    [
      ...stateChangingWitnessIndexesByTarget.values(),
      ...successfulMutationWitnessIndexesByTarget.values(),
    ].flat(),
  );

  const evidence: ReviewerEvidence[] = [];
  let projectionComplete = true;
  let supersededExecutionCount = 0;
  let retainedFailedExecutionCount = 0;
  let retainedUntargetedExecutionCount = 0;
  let sourceReferenceDataCount = 0;
  let sourceReferenceDataChars = 0;
  let retainedReferenceDataCount = 0;
  let retainedReferenceDataChars = 0;
  let omittedReferenceDataCount = 0;
  let omittedReferenceDataChars = 0;
  const currentIndexes: number[] = [];
  const retainedWitnessIndexes: number[] = [];
  const sourceReferenceDataByIndex = new Map<number, string>();

  for (let index = 0; index < candidates.length; index += 1) {
    const sourceReferenceData = projectEvidenceSourceReferenceData(
      candidates[index]!,
    );
    if (!sourceReferenceData) continue;
    sourceReferenceDataByIndex.set(index, sourceReferenceData);
    sourceReferenceDataCount += 1;
    sourceReferenceDataChars += sourceReferenceData.length;
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const targets = (candidate.references ?? []).map(({ target }) => target);
    const isCore = targets.length === 0 || coreIndexSet.has(index);
    const isWitness = !isCore && preconditionWitnessIndexes.has(index);
    if (!isCore && !isWitness) {
      supersededExecutionCount += 1;
      continue;
    }
    if (candidate.outcome === "failed") retainedFailedExecutionCount += 1;
    if (targets.length === 0) retainedUntargetedExecutionCount += 1;
    if (isWitness) {
      retainedWitnessIndexes.push(index);
    } else {
      currentIndexes.push(index);
    }
  }

  const retainedIndexes = [...currentIndexes, ...retainedWitnessIndexes].sort(
    (left, right) => left - right,
  );
  const projectedCurrentIndexes = currentIndexes.slice(-REVIEWER_MAX_EVIDENCE);
  const remainingWitnessSlots = Math.max(
    0,
    REVIEWER_MAX_EVIDENCE - projectedCurrentIndexes.length,
  );
  const projectedWitnessIndexes =
    remainingWitnessSlots > 0
      ? retainedWitnessIndexes.slice(-remainingWitnessSlots)
      : [];
  const projectedIndexes = [
    ...projectedCurrentIndexes,
    ...projectedWitnessIndexes,
  ].sort((left, right) => left - right);
  const projectedIndexSet = new Set(projectedIndexes);
  if (projectedIndexes.length !== retainedIndexes.length) {
    projectionComplete = false;
  }
  const projectedReferenceData = allocateReferenceDataFairly(
    projectedIndexes.flatMap((index) => {
      const referenceData = sourceReferenceDataByIndex.get(index);
      return referenceData ? [{ index, referenceData }] : [];
    }),
    referenceDataBudget,
  );
  for (const index of retainedIndexes) {
    const sourceReferenceData = sourceReferenceDataByIndex.get(index);
    if (!projectedIndexSet.has(index) && sourceReferenceData) {
      omittedReferenceDataCount += 1;
      omittedReferenceDataChars += sourceReferenceData.length;
    }
  }

  for (const index of projectedIndexes) {
    const candidate = candidates[index]!;
    const sourceReferenceData = sourceReferenceDataByIndex.get(index);
    const referenceProjection = projectedReferenceData.get(index);
    const referenceData = referenceProjection?.value;
    if (sourceReferenceData) {
      if (referenceProjection) {
        retainedReferenceDataCount += 1;
        retainedReferenceDataChars += referenceProjection.retainedSourceChars;
        if (referenceProjection.omittedSourceChars > 0) {
          omittedReferenceDataCount += 1;
          omittedReferenceDataChars += referenceProjection.omittedSourceChars;
          projectionComplete = false;
        }
      } else {
        omittedReferenceDataCount += 1;
        omittedReferenceDataChars += sourceReferenceData.length;
        projectionComplete = false;
      }
    }
    evidence.push(
      Object.freeze({
        evidenceRef: candidate.executionId,
        kind: "capability_execution",
        outcome: candidate.outcome,
        effect: candidate.observedEffect,
        subjectRefs: Object.freeze([candidate.subjectRef]),
        summary: boundedSummary(candidate.summary),
        ...(candidate.references
          ? { references: Object.freeze([...candidate.references]) }
          : {}),
        ...(referenceData ? { referenceData } : {}),
      }),
    );
  }

  return Object.freeze({
    evidence: Object.freeze(evidence),
    projectionComplete,
    sourceExecutionCount: candidates.length,
    supersededExecutionCount,
    retainedFailedExecutionCount,
    retainedUntargetedExecutionCount,
    sourceReferenceDataCount,
    sourceReferenceDataChars,
    retainedReferenceDataCount,
    retainedReferenceDataChars,
    omittedReferenceDataCount,
    omittedReferenceDataChars,
  });
}

function projectEvidenceSourceReferenceData(
  candidate: ReviewerEvidenceCandidate,
): string | undefined {
  const summaryProjection = projectBoundedSummary(candidate.summary);
  const normalizedSummary = summaryProjection.normalized;
  if (normalizedSummary.length <= REVIEWER_ITEM_SUMMARY_MAX_LENGTH) {
    return candidate.referenceData;
  }
  return JSON.stringify({
    kind: REVIEWER_SUMMARY_CONTINUATION_KIND,
    evidenceRef: candidate.executionId,
    summary: {
      sourceCharacters: normalizedSummary.length,
      retainedCharacters: summaryProjection.retained.length,
      continuation: summaryProjection.continuation,
    },
    ...(candidate.referenceData
      ? { originalReferenceData: candidate.referenceData }
      : {}),
  });
}

type ReferenceDataProjection = Readonly<{
  value: string;
  retainedSourceChars: number;
  omittedSourceChars: number;
}>;

function allocateReferenceDataFairly(
  sources: readonly Readonly<{ index: number; referenceData: string }>[],
  budget: ReviewerReferenceDataBudget,
): ReadonlyMap<number, ReferenceDataProjection> {
  const allocations = new Map<number, ReferenceDataProjection>();
  let remainingTokens = Math.max(0, Math.floor(budget.maxTokens));
  let pending = [...sources];

  while (pending.length > 0 && remainingTokens > 0) {
    const equalShare = Math.floor(remainingTokens / pending.length);
    if (equalShare <= 0) break;
    const fullyFitting = pending.filter(
      ({ referenceData }) =>
        estimateReferenceDataTokens(referenceData, budget.tokenEstimation) <=
        equalShare,
    );
    if (fullyFitting.length > 0) {
      const fittingIndexes = new Set(fullyFitting.map(({ index }) => index));
      for (const source of fullyFitting) {
        const cost = estimateReferenceDataTokens(
          source.referenceData,
          budget.tokenEstimation,
        );
        allocations.set(source.index, {
          value: source.referenceData,
          retainedSourceChars: source.referenceData.length,
          omittedSourceChars: 0,
        });
        remainingTokens -= cost;
      }
      pending = pending.filter(({ index }) => !fittingIndexes.has(index));
      continue;
    }

    const remainder = remainingTokens % pending.length;
    for (let index = 0; index < pending.length; index += 1) {
      const source = pending[index]!;
      const tokenShare = equalShare + (index < remainder ? 1 : 0);
      const projection = projectReferenceDataWithinBudget(
        source.referenceData,
        tokenShare,
        budget.tokenEstimation,
      );
      if (projection) allocations.set(source.index, projection);
    }
    break;
  }

  return allocations;
}

function projectReferenceDataWithinBudget(
  source: string,
  maxTokens: number,
  tokenEstimation?: ModelTokenEstimationConfig,
): ReferenceDataProjection | undefined {
  if (
    source.length <= REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH &&
    estimateReferenceDataTokens(source, tokenEstimation) <= maxTokens
  ) {
    return {
      value: source,
      retainedSourceChars: source.length,
      omittedSourceChars: 0,
    };
  }

  let low = 0;
  let high = Math.min(
    source.length,
    REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH,
  );
  let best: ReferenceDataProjection | undefined;
  while (low <= high) {
    const retainedSourceChars = Math.floor((low + high) / 2);
    const value = createTruncatedReferenceData(source, retainedSourceChars);
    const fits =
      value.length <= REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH &&
      estimateReferenceDataTokens(value, tokenEstimation) <= maxTokens;
    if (fits) {
      best = {
        value,
        retainedSourceChars,
        omittedSourceChars: source.length - retainedSourceChars,
      };
      low = retainedSourceChars + 1;
    } else {
      high = retainedSourceChars - 1;
    }
  }
  return best;
}

function createTruncatedReferenceData(
  source: string,
  retainedSourceChars: number,
): string {
  const omittedSourceChars = source.length - retainedSourceChars;
  const marker = `[runtime projection omitted ${omittedSourceChars} of ${source.length} source characters]`;
  if (retainedSourceChars === 0) return marker;
  const headLength = Math.ceil(retainedSourceChars / 2);
  const tailLength = retainedSourceChars - headLength;
  return `${source.slice(0, headLength)}\n${marker}\n${
    tailLength > 0 ? source.slice(-tailLength) : ""
  }`;
}

export function estimateReferenceDataTokens(
  referenceData: string,
  tokenEstimation?: ModelTokenEstimationConfig,
): number {
  return estimateTextTokens(JSON.stringify({ referenceData }), tokenEstimation);
}

function boundedSummary(value: string): string {
  return projectBoundedSummary(value).retained;
}

function projectBoundedSummary(value: string): Readonly<{
  normalized: string;
  retained: string;
  continuation: string;
}> {
  const normalized = value.trim();
  let boundary = Math.min(normalized.length, REVIEWER_ITEM_SUMMARY_MAX_LENGTH);
  if (
    boundary > 0 &&
    boundary < normalized.length &&
    isHighSurrogate(normalized.charCodeAt(boundary - 1)) &&
    isLowSurrogate(normalized.charCodeAt(boundary))
  ) {
    boundary -= 1;
  }
  return Object.freeze({
    normalized,
    retained: normalized.slice(0, boundary),
    continuation: normalized.slice(boundary),
  });
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
