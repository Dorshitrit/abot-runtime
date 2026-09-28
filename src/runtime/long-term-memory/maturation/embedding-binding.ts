import type { LongTermMemoryRepositorySnapshot, MemoryVectorIndexEntry } from "../contracts.js";
import { isCandidateUnexpired } from "./retention.js";

type EmbeddingBinding = Pick<MemoryVectorIndexEntry, "dimensions" | "modelFingerprint">;

export function currentLearningEmbeddingBinding(
  current: LongTermMemoryRepositorySnapshot,
  now: number,
): EmbeddingBinding | undefined {
  const candidates = (current.learningCandidates ?? []).filter((record) => isCandidateUnexpired(record, now));
  const vectors = [...current.vectors, ...candidates.map((record) => record.embedding)];
  const binding = vectors[0];
  if (!binding) return undefined;
  assertCompatibleLearningEmbeddings(vectors, binding);
  return { dimensions: binding.dimensions, modelFingerprint: binding.modelFingerprint };
}

export function assertCompatibleLearningEmbeddings(
  vectors: Iterable<EmbeddingBinding>,
  binding: EmbeddingBinding | undefined,
): void {
  if (!binding) return;
  for (const vector of vectors) {
    if (vector.dimensions !== binding.dimensions) throw new Error("learning_embedding_reindex_required");
    if (vector.modelFingerprint !== binding.modelFingerprint) throw new Error("learning_embedding_reindex_required");
  }
}
