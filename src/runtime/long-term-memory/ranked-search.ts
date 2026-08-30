import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRecord,
  LongTermMemoryRepository,
  LongTermMemoryRepositorySnapshot,
  MemoryVectorIndexEntry,
} from "./contracts.js";
import { embedLongTermMemoryTexts } from "./embedding-batches.js";
import { scoreMemory, type ScoredMemory } from "./policies/scoring.js";

type PendingVectorIndexAddition = Readonly<{
  entry: MemoryVectorIndexEntry;
  sourceContent: string;
}>;

export async function searchRankedLongTermMemories(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  query: string;
  context: Readonly<{
    abortSignal: AbortSignal;
    debugRequestId?: string;
  }>;
}): Promise<readonly ScoredMemory[]> {
  params.context.abortSignal.throwIfAborted();
  const query = params.query.trim();
  const snapshot = await params.repository.read();
  if (!query || snapshot.records.length === 0) {
    return Object.freeze([]);
  }
  const queryEmbedding = await embedLongTermMemoryTexts({
    embeddings: params.embeddings,
    texts: [query],
    abortSignal: params.context.abortSignal,
    ...(params.context.debugRequestId
      ? { debugRequestId: params.context.debugRequestId }
      : {}),
  });
  params.context.abortSignal.throwIfAborted();
  const indexedSnapshot = await ensureCurrentVectorIndex({
    repository: params.repository,
    embeddings: params.embeddings,
    snapshot,
    modelFingerprint: queryEmbedding.modelFingerprint,
    dimensions: queryEmbedding.dimensions,
    context: params.context,
  });
  return rankSnapshot({
    snapshot: indexedSnapshot,
    query,
    queryVector: queryEmbedding.vectors[0]!,
    modelFingerprint: queryEmbedding.modelFingerprint,
    dimensions: queryEmbedding.dimensions,
  });
}

async function ensureCurrentVectorIndex(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  snapshot: LongTermMemoryRepositorySnapshot;
  modelFingerprint: string;
  dimensions: number;
  context: Readonly<{
    abortSignal: AbortSignal;
    debugRequestId?: string;
  }>;
}): Promise<LongTermMemoryRepositorySnapshot> {
  const currentEntries = selectCurrentEntries(params);
  const indexedIds = new Set(currentEntries.map(({ memoryId }) => memoryId));
  const missing = params.snapshot.records.filter(
    (record) => !indexedIds.has(record.id),
  );
  if (missing.length === 0) {
    return params.snapshot;
  }
  const additions = await embedMissingRecords({ ...params, missing });
  return params.repository.update((current) => ({
    records: current.records,
    vectors: mergeCurrentVectorIndex({
      snapshot: current,
      modelFingerprint: params.modelFingerprint,
      dimensions: params.dimensions,
      additions,
    }),
  }));
}

async function embedMissingRecords(params: {
  embeddings: LongTermMemoryEmbeddingClient;
  missing: readonly LongTermMemoryRecord[];
  modelFingerprint: string;
  dimensions: number;
  context: Readonly<{
    abortSignal: AbortSignal;
    debugRequestId?: string;
  }>;
}): Promise<readonly PendingVectorIndexAddition[]> {
  const embedded = await embedLongTermMemoryTexts({
    embeddings: params.embeddings,
    texts: params.missing.map(({ content }) => content),
    abortSignal: params.context.abortSignal,
    ...(params.context.debugRequestId
      ? { debugRequestId: params.context.debugRequestId }
      : {}),
    expectedBinding: {
      modelFingerprint: params.modelFingerprint,
      dimensions: params.dimensions,
    },
  });
  return Object.freeze(
    params.missing.map((record, index) =>
      Object.freeze({
        entry: Object.freeze({
          memoryId: record.id,
          modelFingerprint: params.modelFingerprint,
          dimensions: params.dimensions,
          vector: embedded.vectors[index]!,
        }),
        sourceContent: record.content,
      }),
    ),
  );
}

function selectCurrentEntries(params: {
  snapshot: LongTermMemoryRepositorySnapshot;
  modelFingerprint: string;
  dimensions: number;
}): readonly MemoryVectorIndexEntry[] {
  return params.snapshot.vectors.filter(
    (entry) =>
      entry.modelFingerprint === params.modelFingerprint &&
      entry.dimensions === params.dimensions,
  );
}

function mergeCurrentVectorIndex(params: {
  snapshot: LongTermMemoryRepositorySnapshot;
  modelFingerprint: string;
  dimensions: number;
  additions: readonly PendingVectorIndexAddition[];
}): readonly MemoryVectorIndexEntry[] {
  const recordsById = new Map(
    params.snapshot.records.map((record) => [record.id, record]),
  );
  const applicableAdditions = params.additions.filter((addition) =>
    matchesEmbeddingSource(recordsById.get(addition.entry.memoryId), addition),
  );
  const additionsById = new Map(
    applicableAdditions.map(({ entry }) => [entry.memoryId, entry]),
  );
  const retained = selectCurrentEntries(params).filter(
    (entry) =>
      recordsById.has(entry.memoryId) && !additionsById.has(entry.memoryId),
  );
  return Object.freeze([
    ...retained,
    ...applicableAdditions.map(({ entry }) => entry),
  ]);
}

function matchesEmbeddingSource(
  record: LongTermMemoryRecord | undefined,
  addition: PendingVectorIndexAddition,
): boolean {
  return record?.content === addition.sourceContent;
}

function rankSnapshot(params: {
  snapshot: LongTermMemoryRepositorySnapshot;
  query: string;
  queryVector: readonly number[];
  modelFingerprint: string;
  dimensions: number;
}): readonly ScoredMemory[] {
  const vectors = new Map(
    selectCurrentEntries(params).map((entry) => [entry.memoryId, entry.vector]),
  );
  const newestTimestampMs = Math.max(
    0,
    ...params.snapshot.records.map(({ updatedAt }) => Date.parse(updatedAt)),
  );
  return Object.freeze(
    params.snapshot.records
      .map((record) => {
        const memoryVector = vectors.get(record.id);
        return memoryVector
          ? scoreMemory({
              record,
              query: params.query,
              queryVector: params.queryVector,
              memoryVector,
              newestTimestampMs,
            })
          : undefined;
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      )
      .sort((left, right) => right.score - left.score),
  );
}
