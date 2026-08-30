import { randomUUID } from "node:crypto";

import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRecord,
  LongTermMemoryRepository,
  LongTermMemoryRequestContext,
  MemoryCandidate,
} from "./contracts.js";
import {
  mergeMemoryTags,
  normalizeMemoryIdentifier,
  normalizeMemoryText,
} from "./policies/normalization.js";
import { reconcileMemoryCandidate } from "./policies/reconciliation.js";

type EmbeddingBatch = Awaited<
  ReturnType<LongTermMemoryEmbeddingClient["embed"]>
>;

export type MemoryCandidatePersistenceResult = Readonly<{
  acceptedCount: number;
  duplicateCount: number;
}>;

export async function persistMemoryCandidates(params: {
  repository: LongTermMemoryRepository;
  preparedCandidates: readonly MemoryCandidate[];
  freshCandidates: readonly MemoryCandidate[];
  embedded?: EmbeddingBatch;
  context: LongTermMemoryRequestContext;
  now?: () => Date;
  createId?: () => string;
}): Promise<MemoryCandidatePersistenceResult> {
  const vectorByContent = buildVectorMap(
    params.freshCandidates,
    params.embedded,
  );
  const now = (params.now ?? (() => new Date()))().toISOString();
  const createId = params.createId ?? randomUUID;
  let result: MemoryCandidatePersistenceResult | undefined;
  await params.repository.update((current) => {
    params.context.abortSignal.throwIfAborted();
    const records = [...current.records];
    const vectors = [...current.vectors];
    let acceptedCount = 0;
    let duplicateCount = 0;
    for (const candidate of params.preparedCandidates) {
      const existingIndex = findRecordIndex(records, candidate);
      if (existingIndex >= 0) {
        duplicateCount += 1;
        records[existingIndex] = mergeDuplicateRecord(
          records[existingIndex]!,
          candidate,
          now,
        );
        continue;
      }
      const vector = vectorByContent.get(
        normalizeMemoryText(candidate.content),
      );
      if (!vector || !params.embedded) {
        throw new Error("long_term_memory_candidate_embedding_missing");
      }
      const id = createAvailableMemoryId(createId, records, vectors);
      const record = createMemoryRecord({
        candidate,
        context: params.context,
        now,
        id,
      });
      reconcileMemoryCandidate({
        candidate,
        vector,
        existingVectors: compatibleVectors(vectors, params.embedded),
      });
      records.push(record);
      acceptedCount += 1;
      vectors.push(
        Object.freeze({
          memoryId: record.id,
          modelFingerprint: params.embedded.modelFingerprint,
          dimensions: params.embedded.dimensions,
          vector,
        }),
      );
    }
    result = Object.freeze({ acceptedCount, duplicateCount });
    return { records: Object.freeze(records), vectors: Object.freeze(vectors) };
  });
  if (!result) {
    throw new Error("long_term_memory_candidate_persistence_outcome_missing");
  }
  return result;
}

function createAvailableMemoryId(
  createId: () => string,
  records: readonly LongTermMemoryRecord[],
  vectors: readonly Readonly<{ memoryId: string }>[],
): string {
  const id = normalizeMemoryIdentifier(createId());
  if (!id) {
    throw new Error("long_term_memory_candidate_id_invalid");
  }
  const idInUse =
    records.some((record) => record.id === id) ||
    vectors.some((entry) => entry.memoryId === id);
  if (idInUse) {
    throw new Error("long_term_memory_candidate_id_conflict");
  }
  return id;
}

function buildVectorMap(
  candidates: readonly MemoryCandidate[],
  embedded: EmbeddingBatch | undefined,
): ReadonlyMap<string, readonly number[]> {
  const validCount = embedded?.vectors.length === candidates.length;
  if (!validCount && candidates.length > 0) {
    throw new Error("long_term_memory_embedding_vector_count_invalid");
  }
  if (!embedded) {
    return new Map();
  }
  return new Map(
    candidates.map((candidate, index) => [
      normalizeMemoryText(candidate.content),
      embedded.vectors[index]!,
    ]),
  );
}

function findRecordIndex(
  records: readonly LongTermMemoryRecord[],
  candidate: MemoryCandidate,
): number {
  const candidateKey = normalizeMemoryText(candidate.content);
  return records.findIndex(
    (record) => normalizeMemoryText(record.content) === candidateKey,
  );
}

function compatibleVectors(
  vectors: readonly Readonly<{
    memoryId: string;
    modelFingerprint: string;
    dimensions: number;
    vector: readonly number[];
  }>[],
  embedded: EmbeddingBatch,
) {
  return vectors
    .filter(
      (entry) =>
        entry.modelFingerprint === embedded.modelFingerprint &&
        entry.dimensions === embedded.dimensions,
    )
    .map((entry) => ({ memoryId: entry.memoryId, vector: entry.vector }));
}

function mergeDuplicateRecord(
  record: LongTermMemoryRecord,
  candidate: MemoryCandidate,
  updatedAt: string,
): LongTermMemoryRecord {
  const tags = mergeMemoryTags(record.tags, candidate.tags);
  return tags.length === record.tags.length
    ? record
    : Object.freeze({ ...record, tags, updatedAt });
}

function createMemoryRecord(params: {
  candidate: MemoryCandidate;
  context: LongTermMemoryRequestContext;
  now: string;
  id: string;
}): LongTermMemoryRecord {
  return Object.freeze({
    id: params.id,
    content: params.candidate.content,
    tags: params.candidate.tags,
    provenance: Object.freeze({
      kind: "passive_response" as const,
      sourceSessionId: params.context.sessionId,
      sourceRequestId: params.context.requestId,
    }),
    createdAt: params.now,
    updatedAt: params.now,
  });
}
