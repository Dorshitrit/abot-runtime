import type { LongTermMemoryRecord, LongTermMemoryRepositorySnapshot } from "../contracts.js";
import type { ApplyLearningDecisionsInput, LearningCandidateRecord, LearningKnowledgeContext, LearningKnowledgeEntry, LearningReviewCause, ScheduledKnowledgeSelection } from "./contracts.js";
import { candidateKnowledge, memoryKnowledge } from "./context.js";
import { isCandidateUnexpired } from "./retention.js";
import { updateMemoryReviewDeadline } from "./memory-update.js";

export function isScheduledKnowledgeReview(cause: LearningReviewCause | undefined): cause is Extract<LearningReviewCause, { kind: "scheduled_knowledge_review" }> {
  return cause?.kind === "scheduled_knowledge_review";
}

export function assertScheduledReviewCause(cause: LearningReviewCause | undefined): void {
  if (cause === undefined) return;
  if (cause.kind === "conversation_memory_review") return;
  if (!isScheduledKnowledgeReview(cause)) throw new Error("learning_review_cause_invalid");
  if (!Array.isArray(cause.dueEntries) || !cause.dueEntries.length || cause.dueEntries.length > 12)
    throw new Error("learning_review_cause_invalid");
  const identities = new Set<string>();
  for (const entry of cause.dueEntries) {
    if (entry.kind !== "candidate" && entry.kind !== "memory") throw new Error("learning_review_cause_invalid");
    if (!isReviewIdentifier(entry.id) || !isReviewIdentifier(entry.version)) throw new Error("learning_review_cause_invalid");
    const identity = `${entry.kind}:${entry.id}`;
    if (identities.has(identity)) throw new Error("learning_review_cause_invalid");
    identities.add(identity);
  }
}

export function nextKnowledgeReconsiderationAt(snapshot: LongTermMemoryRepositorySnapshot, now: number, selection?: ScheduledKnowledgeSelection): string | null {
  const entries = reconsiderableEntries(snapshot, now, selection);
  let earliest = Infinity;
  for (const entry of entries) earliest = Math.min(earliest, Date.parse(entry.reconsiderAt!));
  return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
}

/** No new observation or intent is implied by an explicitly due review trigger. */
export function scheduledKnowledgeContext(snapshot: LongTermMemoryRepositorySnapshot, now: number, selection?: ScheduledKnowledgeSelection): LearningKnowledgeContext {
  const due = reconsiderableEntries(snapshot, now, selection)
    .filter((entry) => Date.parse(entry.reconsiderAt!) <= now)
    .sort((a, b) => a.reconsiderAt!.localeCompare(b.reconsiderAt!) || a.id.localeCompare(b.id));
  const entries: LearningKnowledgeEntry[] = [];
  let size = 0;
  for (const entry of due) {
    if (entries.length >= 12) break;
    const length = JSON.stringify(entry).length;
    if (size + length > 24_000) continue;
    entries.push(entry);
    size += length;
  }
  return { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent",
    repositoryRevision: snapshot.revision, knowledgeRevision: snapshot.knowledgeRevision ?? snapshot.revision,
    referenceTime: new Date(now).toISOString(), entries, omitted: due.length - entries.length };
}

/** Even no-change reviews consume their bound deadline, atomically with the receipt. */
export function consumeScheduledReviewTriggers(
  input: ApplyLearningDecisionsInput,
  candidates: Map<string, LearningCandidateRecord>,
  memories: Map<string, LongTermMemoryRecord>,
  now: number,
): void {
  if (!isScheduledKnowledgeReview(input.cause)) return;
  for (const due of input.cause.dueEntries) {
    const decided = input.decisions.some((decision) => decision.targetKind === due.kind && decision.targetId === due.id);
    if (decided && due.kind === "candidate") continue;
    if (decided && !memories.has(due.id)) continue;
    if (decided && memories.get(due.id)?.updatedAt !== due.version) continue;
    if (due.kind === "candidate") {
      const candidate = candidates.get(due.id)!;
      candidates.set(due.id, { ...candidate, revision: candidate.revision + 1, reconsiderAt: null, updatedAt: reviewCommitTime(candidate.updatedAt, now) });
      continue;
    }
    const memory = memories.get(due.id)!;
    memories.set(due.id, updateMemoryReviewDeadline(memory, null, candidates, now));
  }
}

function reconsiderableEntries(snapshot: LongTermMemoryRepositorySnapshot, now: number, selection?: ScheduledKnowledgeSelection): LearningKnowledgeEntry[] {
  const candidates = (snapshot.learningCandidates ?? []).filter((candidate) => isCandidateUnexpired(candidate, now));
  const excluded = new Set((selection?.exclude ?? []).map(reviewBindingKey));
  return [...candidates.map(candidateKnowledge), ...snapshot.records.map(memoryKnowledge)]
    .filter(hasMutableReviewDeadline)
    .filter((entry) => !excluded.has(reviewBindingKey(entry)));
}

function reviewBindingKey(entry: Pick<LearningKnowledgeEntry, "kind" | "id" | "version">): string {
  return JSON.stringify([entry.kind, entry.id, entry.version]);
}

function hasMutableReviewDeadline(entry: LearningKnowledgeEntry): boolean {
  if (!entry.mutable) return false;
  return entry.reconsiderAt !== null;
}

function isReviewIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function reviewCommitTime(previous: string, now: number): string {
  return new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();
}
