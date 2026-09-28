import type { LongTermMemoryRepositorySnapshot } from "../contracts.js";
import type { LearningKnowledgeContext, LearningKnowledgeEntry } from "./contracts.js";
import { candidateKnowledge, memoryKnowledge } from "./context.js";
import { isCandidateUnexpired } from "./retention.js";

/** Bounded recent/due index for proactive review; no embedding or full-store projection. */
export function learningKnowledgeOverview(snapshot: LongTermMemoryRepositorySnapshot, now: number): LearningKnowledgeContext {
  const candidates = (snapshot.learningCandidates ?? []).filter((record) => isCandidateUnexpired(record, now));
  const entries = [
    ...candidates.map((record) => ({ entry: candidateKnowledge(record), updatedAt: record.updatedAt })),
    ...snapshot.records.map((record) => ({ entry: memoryKnowledge(record), updatedAt: record.updatedAt })),
  ].sort((a, b) => duePriority(b.entry, now) - duePriority(a.entry, now) || b.updatedAt.localeCompare(a.updatedAt));
  const selected: LearningKnowledgeEntry[] = [];
  let size = 0;
  for (const { entry } of entries) {
    if (selected.length >= 12) break;
    const length = JSON.stringify(entry).length;
    if (length + size > 24_000) continue;
    selected.push(entry); size += length;
  }
  return { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent",
    repositoryRevision: snapshot.revision, knowledgeRevision: snapshot.knowledgeRevision ?? snapshot.revision,
    referenceTime: new Date(now).toISOString(), entries: selected, omitted: entries.length - selected.length };
}

function duePriority(entry: LearningKnowledgeEntry, now: number): number {
  if (entry.reconsiderAt && Date.parse(entry.reconsiderAt) <= now) return 1;
  return 0;
}
