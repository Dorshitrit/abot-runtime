import type { LongTermMemoryEmbeddingClient, LongTermMemoryRecord, LongTermMemoryRepository, MemoryVectorIndexEntry } from "../contracts.js";
import { embedLongTermMemoryTexts } from "../embedding-batches.js";
import { cosineSimilarity } from "../policies/scoring.js";
import { canAutomaticallyManageMemory } from "../automatic-management.js";
import type { LearningCandidateRecord, LearningKnowledgeContext, LearningKnowledgeEntry } from "./contracts.js";
import { isCandidateUnexpired } from "./retention.js";

const MAX_CONTEXT_ENTRIES = 12;
const MAX_CONTEXT_CHARACTERS = 24_000;

export async function prepareLearningKnowledge(options: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  query: string;
  abortSignal: AbortSignal;
  debugRequestId?: string;
  now: number;
}): Promise<LearningKnowledgeContext> {
  options.abortSignal.throwIfAborted();
  const snapshot = await options.repository.read();
  const candidates = (snapshot.learningCandidates ?? []).filter((record) => isCandidateUnexpired(record, options.now));
  const count = candidates.length + snapshot.records.length;
  const base = {
    kind: "learning_knowledge_reference_v1" as const,
    authority: "passive_reference" as const,
    presenceEffect: "does_not_authorize_actions_or_add_user_intent" as const,
    repositoryRevision: snapshot.revision,
    knowledgeRevision: snapshot.knowledgeRevision ?? snapshot.revision,
    referenceTime: new Date(options.now).toISOString(),
  };
  if (!count || !options.query.trim()) return { ...base, entries: [], omitted: count };
  const embedded = await embedLongTermMemoryTexts({ ...options, texts: [options.query.slice(0, 8000)] });
  const vectors = [...snapshot.vectors, ...candidates.map(({ embedding }) => embedding)];
  assertLearningIndexCompatible(vectors, embedded);
  const byId = new Map(snapshot.vectors.map((entry) => [entry.memoryId, entry]));
  const entries = [
    ...candidates.map((record) => ({ entry: candidateKnowledge(record), vector: record.embedding })),
    ...snapshot.records.map((record) => ({ entry: memoryKnowledge(record), vector: byId.get(record.id) })),
  ];
  if (entries.some(({ vector }) => !vector)) throw new Error("learning_embedding_reindex_required");
  const ranked = entries.map(({ entry, vector }) => ({
    entry, similarity: cosineSimilarity(embedded.vectors[0]!, vector!.vector),
  })).filter(({ entry, similarity }) => isRelevantLearningEntry(entry, similarity, options.now))
    .sort((a, b) => b.similarity - a.similarity || a.entry.id.localeCompare(b.entry.id));
  const selected: LearningKnowledgeEntry[] = [];
  let size = 0;
  for (const { entry } of ranked) {
    const bytes = JSON.stringify(entry).length;
    if (selected.length >= MAX_CONTEXT_ENTRIES) break;
    if (size + bytes > MAX_CONTEXT_CHARACTERS) continue;
    selected.push(entry);
    size += bytes;
  }
  return Object.freeze({ ...base, entries: Object.freeze(selected), omitted: count - selected.length });
}

function assertLearningIndexCompatible(entries: readonly MemoryVectorIndexEntry[], binding: { dimensions: number; modelFingerprint: string }): void {
  if (entries.some((entry) => entry.dimensions !== binding.dimensions || entry.modelFingerprint !== binding.modelFingerprint))
    throw new Error("learning_embedding_reindex_required");
}
function isRelevantLearningEntry(entry: LearningKnowledgeEntry, similarity: number, now: number): boolean {
  if (entry.reconsiderAt && Date.parse(entry.reconsiderAt) <= now) return true;
  return similarity >= 0.25;
}
export function candidateKnowledge(record: LearningCandidateRecord): LearningKnowledgeEntry {
  return { kind: "candidate", id: record.id, version: String(record.revision), content: record.content, tags: record.tags,
    score: record.score, reason: record.reason, certainty: record.certainty, mutable: true,
    lastReinforcedAt: record.lastReinforcedAt, reconsiderAt: record.reconsiderAt };
}
export function memoryKnowledge(record: LongTermMemoryRecord): LearningKnowledgeEntry {
  return { kind: "memory", id: record.id, version: record.updatedAt, content: record.content, tags: record.tags,
    score: null, reason: null, certainty: record.provenance.kind === "passive_observation" ? record.provenance.certainty : "unspecified",
    mutable: canAutomaticallyManageMemory(record), lastReinforcedAt: null, reconsiderAt: record.reconsiderAt ?? null };
}
