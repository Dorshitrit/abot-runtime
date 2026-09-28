import { parseObservationSources } from "../observation-state.js";
import { parseLearningSources, parseLearningReinforcements, parseLearningReplacement } from "./source-state.js";
import type { LearningCandidateRecord, LearningMemoryReceipt } from "./contracts.js";

export function parseLearningCandidates(value: unknown, schemaVersion = 5): readonly LearningCandidateRecord[] {
  if (!Array.isArray(value)) throw new Error("learning_candidates_corrupt");
  const records = value.map((record) => parseLearningCandidate(record, schemaVersion));
  if (new Set(records.map(({ id }) => id)).size !== records.length)
    throw new Error("learning_candidate_identity_duplicate");
  return Object.freeze(records);
}

export function parseLearningReceipts(value: unknown): readonly LearningMemoryReceipt[] {
  if (!Array.isArray(value)) throw new Error("learning_receipts_corrupt");
  return Object.freeze(value.map((raw) => {
    const receipt = object(raw);
    return Object.freeze({
      batchId: text(receipt.batchId),
      recordIds: texts(receipt.recordIds),
      candidateIds: texts(receipt.candidateIds),
      removedCandidateCount: integer(receipt.removedCandidateCount, 0),
      createdAt: timestamp(receipt.createdAt),
      expiresAt: timestamp(receipt.expiresAt),
    });
  }));
}

function parseLearningCandidate(raw: unknown, schemaVersion: number): LearningCandidateRecord {
  const candidate = object(raw);
  const embedding = object(candidate.embedding);
  const dimensions = integer(embedding.dimensions, 1);
  const vector = embedding.vector;
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite))
    throw new Error("learning_candidate_vector_corrupt");
  const score = integer(candidate.score, 0);
  if (score > 100) throw new Error("learning_candidate_score_corrupt");
  const certainty = candidate.certainty;
  if (certainty !== "observed" && certainty !== "inferred")
    throw new Error("learning_candidate_certainty_corrupt");
  const id = text(candidate.id);
  if (embedding.memoryId !== id) throw new Error("learning_candidate_vector_binding_corrupt");
  const replacement = schemaVersion >= 5 && candidate.replacement !== undefined ? parseLearningReplacement(candidate.replacement) : undefined;
  const sources = schemaVersion >= 5 ? parseLearningSources(candidate.sources) : parseObservationSources(candidate.sources);
  // Legacy candidates may lack source history, including after a v5 roundtrip.
  // Reading them does not create the independent evidence required for promotion.
  return Object.freeze({
    id, revision: integer(candidate.revision, 1),
    content: text(candidate.content), tags: texts(candidate.tags),
    score, certainty, reason: text(candidate.reason),
    sources,
    ...(replacement ? { replacement } : {}),
    ...(schemaVersion >= 5 && candidate.reinforcements !== undefined ? { reinforcements: parseLearningReinforcements(candidate.reinforcements) } : {}),
    createdAt: timestamp(candidate.createdAt), updatedAt: timestamp(candidate.updatedAt),
    lastReinforcedAt: timestamp(candidate.lastReinforcedAt), expiresAt: timestamp(candidate.expiresAt),
    reconsiderAt: candidate.reconsiderAt === null ? null : timestamp(candidate.reconsiderAt),
    embedding: Object.freeze({ memoryId: id, dimensions, modelFingerprint: text(embedding.modelFingerprint), vector: Object.freeze([...vector]) as readonly number[] }),
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("learning_maturation_store_corrupt");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("learning_maturation_store_corrupt");
  return value;
}
function texts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("learning_maturation_store_corrupt");
  return Object.freeze(value.map(text));
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("learning_maturation_store_corrupt");
  return result;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error("learning_maturation_store_corrupt");
  return value;
}
