import type { MemoryCandidate } from "../contracts.js";
import { cosineSimilarity } from "./scoring.js";

export type SemanticMemoryNeighbor = Readonly<{
  memoryId: string;
  similarity: number;
}>;

/**
 * Version one deliberately never treats similarity as proof of identity or
 * contradiction. The neighbor is retained only as a testable policy input.
 */
export function reconcileMemoryCandidate(params: {
  candidate: MemoryCandidate;
  vector: readonly number[];
  existingVectors: readonly Readonly<{
    memoryId: string;
    vector: readonly number[];
  }>[];
}): Readonly<{
  action: "accept_distinct";
  nearestNeighbor?: SemanticMemoryNeighbor;
}> {
  let nearestNeighbor: SemanticMemoryNeighbor | undefined;
  for (const existing of params.existingVectors) {
    const similarity = cosineSimilarity(params.vector, existing.vector);
    if (!nearestNeighbor || similarity > nearestNeighbor.similarity) {
      nearestNeighbor = Object.freeze({
        memoryId: existing.memoryId,
        similarity,
      });
    }
  }
  return Object.freeze({
    action: "accept_distinct" as const,
    ...(nearestNeighbor ? { nearestNeighbor } : {}),
  });
}
