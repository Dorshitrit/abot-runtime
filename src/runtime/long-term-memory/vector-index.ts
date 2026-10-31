import { isDeepStrictEqual } from "node:util";
import type { LongTermMemoryEmbeddingClient, LongTermMemoryRepository, LongTermMemoryRepositorySnapshot, MemoryVectorIndexEntry } from "./contracts.js";
import { embedLongTermMemoryTexts } from "./embedding-batches.js";
import type { LearningCandidateRecord } from "./maturation/contracts.js";
import { assertLearningEmbeddingCapacity, DEFAULT_MATURATION_POLICY, isCandidateUnexpired } from "./maturation/retention.js";

type EmbeddingBinding = Pick<MemoryVectorIndexEntry, "modelFingerprint" | "dimensions">;
type IndexSource = Readonly<{ kind: "memory" | "candidate"; id: string; content: string; revision?: number; embedding?: MemoryVectorIndexEntry }>;
type IndexAddition = Readonly<{ source: IndexSource; entry: MemoryVectorIndexEntry }>;

export function matchesEmbeddingBinding(entry: EmbeddingBinding, binding: EmbeddingBinding): boolean {
  return entry.modelFingerprint === binding.modelFingerprint && entry.dimensions === binding.dimensions;
}

/** Refresh derived vectors only; semantic versions, evidence and retention stay unchanged. */
export async function ensureCurrentVectorIndex(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  snapshot: LongTermMemoryRepositorySnapshot;
  modelFingerprint: string;
  dimensions: number;
  now?: () => number;
  context: Readonly<{ abortSignal: AbortSignal; debugRequestId?: string }>;
}): Promise<LongTermMemoryRepositorySnapshot> {
  params.context.abortSignal.throwIfAborted();
  const now = params.now ?? Date.now;
  const originalVectors = new Map(params.snapshot.vectors.map((entry) => [entry.memoryId, entry]));
  const sources: IndexSource[] = [];
  for (const record of params.snapshot.records) {
    const embedding = originalVectors.get(record.id);
    if (!embedding || !matchesEmbeddingBinding(embedding, params))
      sources.push({ kind: "memory", id: record.id, content: record.content, ...(embedding ? { embedding } : {}) });
  }
  for (const candidate of params.snapshot.learningCandidates ?? []) {
    if (isCandidateUnexpired(candidate, now()) && !matchesEmbeddingBinding(candidate.embedding, params))
      sources.push({ kind: "candidate", id: candidate.id, content: candidate.content, revision: candidate.revision, embedding: candidate.embedding });
  }
  if (!sources.length) return params.snapshot;
  const embedded = await embedLongTermMemoryTexts({ embeddings: params.embeddings,
    texts: sources.map(({ content }) => content), ...params.context,
    expectedBinding: { modelFingerprint: params.modelFingerprint, dimensions: params.dimensions } });
  params.context.abortSignal.throwIfAborted();
  const additions = sources.map((source, index): IndexAddition => ({ source,
    entry: { memoryId: source.id, modelFingerprint: embedded.modelFingerprint, dimensions: embedded.dimensions, vector: embedded.vectors[index]! } }));
  return params.repository.update((current) => {
    params.context.abortSignal.throwIfAborted();
    const records = new Map(current.records.map((record) => [record.id, record]));
    const vectors = new Map(current.vectors.filter((entry) => records.has(entry.memoryId)).map((entry) => [entry.memoryId, entry]));
    const candidates = new Map((current.learningCandidates ?? []).map((candidate) => [candidate.id, candidate]));
    for (const { source, entry } of additions) {
      if (source.kind === "memory") {
        const record = records.get(source.id);
        if (record?.content === source.content && isDeepStrictEqual(vectors.get(source.id), source.embedding)) vectors.set(source.id, entry);
        continue;
      }
      const candidate = candidates.get(source.id);
      if (canRefreshCandidate(candidate, source, now())) candidates.set(source.id, { ...candidate, embedding: entry });
    }
    const updatedCandidates = [...candidates.values()];
    assertLearningEmbeddingCapacity(current.learningCandidates ?? [], updatedCandidates,
      current.maturationPolicy ?? DEFAULT_MATURATION_POLICY, now());
    return { records: current.records, vectors: [...vectors.values()],
      ...(current.learningCandidates ? { learningCandidates: updatedCandidates } : {}) };
  });
}

function canRefreshCandidate(candidate: LearningCandidateRecord | undefined, source: IndexSource, now: number): candidate is LearningCandidateRecord {
  if (!candidate || !isCandidateUnexpired(candidate, now)) return false;
  return candidate.content === source.content && candidate.revision === source.revision && isDeepStrictEqual(candidate.embedding, source.embedding);
}
