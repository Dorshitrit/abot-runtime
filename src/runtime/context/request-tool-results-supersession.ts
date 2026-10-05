import type { RequestToolResult } from "./request-tool-results.js";

/**
 * Keeps every canonical execution record while replacing stale successful
 * observations with a small, explicit supersession marker. A mutation makes
 * earlier observations of the same target stale. An exact later observation
 * makes an identical earlier observation redundant. Different observations of
 * one target remain visible because they may cover complementary regions.
 */
export function projectCurrentRequestToolResults(
  results: readonly RequestToolResult[],
): RequestToolResult[] {
  const latestMutationByTarget = new Map<string, string>();
  const latestEquivalentObservation = new Map<string, string>();
  const projected = new Array<RequestToolResult>(results.length);

  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index]!;
    const targets = result.references?.map(({ target }) => target) ?? [];
    const isSuccessfulObservation =
      result.outcome === "succeeded" &&
      result.observedEffect === "observation" &&
      targets.length > 0;
    const isSuccessfulMutation =
      result.outcome === "succeeded" &&
      result.observedEffect === "mutation" &&
      targets.length > 0;
    const supersedingMutationExecutionIds = isSuccessfulObservation
      ? targets
          .map((target) => latestMutationByTarget.get(target))
          .filter((executionId): executionId is string => Boolean(executionId))
      : [];
    const observationKey = isSuccessfulObservation
      ? equivalentObservationKey(result, targets)
      : undefined;
    const equivalentObservationExecutionId = observationKey
      ? latestEquivalentObservation.get(observationKey)
      : undefined;
    const isSupersededByMutation =
      isSuccessfulObservation &&
      supersedingMutationExecutionIds.length === targets.length;
    const isSupersededObservation =
      isSupersededByMutation || Boolean(equivalentObservationExecutionId);
    const supersedingExecutionIds = isSupersededByMutation
      ? supersedingMutationExecutionIds
      : equivalentObservationExecutionId
        ? [equivalentObservationExecutionId]
        : [];

    if (isSupersededObservation) {
      const {
        referenceData: _referenceData,
        adapterResult: _adapterResult,
        ...receipt
      } = result;
      projected[index] = Object.freeze({
        ...receipt,
        summary:
          "Earlier successful observation superseded by later settled evidence for the same target.",
        summaryProjection: "superseded_target_evidence" as const,
        supersededByExecutionIds: Object.freeze([
          ...new Set(supersedingExecutionIds),
        ]),
      });
    } else {
      projected[index] = result;
    }

    if (isSuccessfulMutation) {
      for (const target of targets) {
        if (!latestMutationByTarget.has(target)) {
          latestMutationByTarget.set(target, result.executionId);
        }
      }
    }
    if (
      isSuccessfulObservation &&
      observationKey &&
      !latestEquivalentObservation.has(observationKey)
    ) {
      latestEquivalentObservation.set(observationKey, result.executionId);
    }
  }

  return projected;
}

function equivalentObservationKey(
  result: RequestToolResult,
  targets: readonly string[],
): string {
  const acceptedAction = result.acceptedAction;
  return JSON.stringify([
    result.capabilityId,
    [...targets].sort(),
    ...(acceptedAction
      ? [acceptedAction.controls, acceptedAction.workingDirectory]
      : [result.summary]),
  ]);
}
