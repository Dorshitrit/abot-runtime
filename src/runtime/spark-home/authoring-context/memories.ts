import type { LongTermMemoryRecord } from "../../long-term-memory/contracts.js";
import type { LearningCandidateRecord } from "../../long-term-memory/maturation/contracts.js";
import { AUTHORING_CONTEXT_LIMITS as limits } from "./contracts.js";
import { boundEntries, clippedText, inactiveSection } from "./projection.js";
import type { CapturedMemoryRecords } from "./memory-records.js";

function savedProjection(record: LongTermMemoryRecord) {
  const content = clippedText(record.content, 1200);
  const observations = record.observationSources ?? [];
  return {
    id: record.id, status: "saved", content: content.text,
    omittedContentCharacters: content.omittedCharacters,
    certainty: record.provenance.kind === "passive_observation" ? record.provenance.certainty : "unspecified",
    provenance: record.provenance,
    observationSources: observations.slice(-2), omittedObservationSources: Math.max(0, observations.length - 2),
    tags: record.tags.slice(0, 8), omittedTags: Math.max(0, record.tags.length - 8),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

function candidateProjection(record: LearningCandidateRecord) {
  const content = clippedText(record.content, 1000);
  const reason = clippedText(record.reason, 300);
  return {
    id: record.id, revision: record.revision, status: "candidate_not_saved",
    content: content.text, omittedContentCharacters: content.omittedCharacters,
    certainty: record.certainty, reason: reason.text, omittedReasonCharacters: reason.omittedCharacters,
    sources: record.sources.slice(-2), omittedSources: Math.max(0, record.sources.length - 2),
    createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt,
  };
}

export function projectAuthoringMemories(snapshot: CapturedMemoryRecords) {
  if (!snapshot.enabled) {
    const disabled = inactiveSection("disabled", "long_term_memory_disabled");
    return { saved: disabled, passive: disabled, candidates: disabled };
  }
  return {
    saved: boundEntries(snapshot.saved.records.map(savedProjection),
      limits.savedMemories, limits.savedCharacters, {
        availableCount: snapshot.saved.availableCount, scannedCount: snapshot.saved.scannedCount,
        selection: "latest_updated_within_last_500_stored_records; passive_records_excluded",
      }),
    passive: boundEntries(snapshot.passive.records.map(savedProjection), limits.passiveMemories,
      limits.passiveCharacters, { availableCount: snapshot.passive.availableCount, scannedCount: snapshot.passive.scannedCount,
        selection: "latest_updated_within_last_500_stored_passive_records" }),
    candidates: { ...boundEntries(snapshot.candidates.records.map(candidateProjection), limits.candidates,
      limits.candidateCharacters, { availableCount: snapshot.candidates.availableCount, scannedCount: snapshot.candidates.scannedCount,
        selection: "unexpired_candidates_latest_updated; hypotheses_not_saved_facts" }),
      excludedExpiredCount: snapshot.candidates.excludedExpiredCount },
  };
}
