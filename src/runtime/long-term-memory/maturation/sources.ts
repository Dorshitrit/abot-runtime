import type { LearningMemorySource } from "./evidence-contracts.js";

/** Keep merged evidence bounded without counting the same observation batch twice. */
export function mergeLearningSources(
  sources: readonly LearningMemorySource[],
): readonly LearningMemorySource[] {
  const byIdentity = new Map<string, LearningMemorySource>();
  for (const source of sources) {
    const identity = JSON.stringify(source.kind === "passive_response"
      ? [source.kind, source.sourceSessionId, source.sourceRequestId]
      : [source.kind, source.environmentId, source.deviceId, source.batchId, [...source.observationIds].sort()]);
    byIdentity.delete(identity);
    byIdentity.set(identity, source);
  }
  return [...byIdentity.values()].slice(-8);
}
