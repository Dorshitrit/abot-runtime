import { randomUUID } from "node:crypto";
import type { LongTermMemoryRecord } from "../contracts.js";
import { canAutomaticallyManageMemory } from "../automatic-management.js";
import { normalizeMemoryText } from "../policies/normalization.js";
import type { LearningCandidateRecord, LearningMemoryDecision } from "./contracts.js";
import type { LearningMemoryReplacement } from "./evidence-contracts.js";

/** Content changes to established memory go through the same candidate gate. */
export function prepareLearningMemoryUpdate(
  decision: LearningMemoryDecision, records: ReadonlyMap<string, LongTermMemoryRecord>, candidates: ReadonlyMap<string, LearningCandidateRecord>,
): { id: string; previous?: LearningCandidateRecord; replacement?: LearningMemoryReplacement; unchanged?: LongTermMemoryRecord } {
  if (decision.targetKind !== "memory") {
    const id = decision.targetId ?? randomUUID();
    const previous = candidates.get(id);
    return { id, previous, replacement: previous?.replacement };
  }
  const record = records.get(decision.targetId!);
  if (!record || !canAutomaticallyManageMemory(record)) throw new Error("learning_memory_protected");
  if (decision.action !== "merge" && hasUnchangedMemoryKnowledge(record, decision)) return { id: record.id, unchanged: record };
  const contentKey = normalizeMemoryText(decision.content);
  const previous = [...candidates.values()].find(candidate =>
    candidate.replacement?.id === record.id && candidate.replacement.version === record.updatedAt &&
    normalizeMemoryText(candidate.content) === contentKey);
  return { id: previous?.id ?? randomUUID(), previous, replacement: { id: record.id, version: record.updatedAt } };
}

export function canCommitLearningReplacement(candidate: LearningCandidateRecord, records: ReadonlyMap<string, LongTermMemoryRecord>): boolean {
  if (!candidate.replacement) return true;
  const target = records.get(candidate.replacement.id);
  if (!target || !canAutomaticallyManageMemory(target)) return false;
  return target.updatedAt === candidate.replacement.version;
}

export function updateMemoryReviewDeadline(record: LongTermMemoryRecord, reconsiderAt: string | null, candidates: Map<string, LearningCandidateRecord>, now: number): LongTermMemoryRecord {
  if ((record.reconsiderAt ?? null) === reconsiderAt) return record;
  const updatedAt = new Date(Math.max(now, Date.parse(record.updatedAt) + 1)).toISOString();
  for (const [id, candidate] of candidates) {
    if (candidate.replacement?.id === record.id && candidate.replacement.version === record.updatedAt)
      candidates.set(id, { ...candidate, replacement: { id: record.id, version: updatedAt } });
  }
  return { ...record, reconsiderAt, updatedAt };
}

function hasUnchangedMemoryKnowledge(record: LongTermMemoryRecord, decision: LearningMemoryDecision): boolean {
  if (record.content !== decision.content) return false;
  return JSON.stringify(record.tags) === JSON.stringify(decision.tags);
}
