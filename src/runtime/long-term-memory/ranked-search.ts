import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRepository,
  LongTermMemoryRepositorySnapshot,
} from "./contracts.js";
import { embedLongTermMemoryTexts } from "./embedding-batches.js";
import { scoreMemory, type ScoredMemory } from "./policies/scoring.js";
import { ensureCurrentVectorIndex, matchesEmbeddingBinding } from "./vector-index.js";

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

function rankSnapshot(params: {
  snapshot: LongTermMemoryRepositorySnapshot;
  query: string;
  queryVector: readonly number[];
  modelFingerprint: string;
  dimensions: number;
}): readonly ScoredMemory[] {
  const vectors = new Map(
    params.snapshot.vectors.filter((entry) => matchesEmbeddingBinding(entry, params)).map((entry) => [entry.memoryId, entry.vector]),
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
