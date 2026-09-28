import type {
  ObservationMemorySource,
  SaveObservationMemoryInput,
} from "./observation-contracts.js";

/** Bind model-selected source IDs only to the submitted observation batch. */
export function bindObservationSource(
  input: SaveObservationMemoryInput,
  proposal: SaveObservationMemoryInput["proposals"][number],
): ObservationMemorySource {
  if (!proposal.observationIds.length || !proposal.reason.trim())
    throw new Error("learning_proposal_source_required");
  const sources = proposal.observationIds.map((id) =>
    input.observations.find((observation) => observation.id === id),
  );
  if (sources.some((source) => !source))
    throw new Error("learning_proposal_source_unknown");
  const deviceId = sources[0]!.deviceId;
  if (sources.some((source) => source!.deviceId !== deviceId))
    throw new Error("learning_proposal_device_mismatch");
  return Object.freeze({
    kind: "passive_observation",
    environmentId: input.environmentId,
    deviceId,
    batchId: input.batchId,
    observationIds: Object.freeze([...new Set(proposal.observationIds)]),
    observedAt: sources
      .map((source) => source!.timestamp)
      .sort()
      .at(-1)!,
    reason: proposal.reason.replace(/\s+/gu, " ").trim(),
    certainty: proposal.certainty,
  });
}
