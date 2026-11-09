import type { LongTermMemoryProvenance, LongTermMemoryRecord } from "../../long-term-memory/contracts.js";
import type { LearningCandidateRecord } from "../../long-term-memory/maturation/contracts.js";
import type { LearningMemorySource } from "../../long-term-memory/maturation/evidence-contracts.js";
import { AUTHORING_CONTEXT_LIMITS as limits, type ReferenceEntry } from "./contracts.js";
import type { CapturedMemoryRecords } from "./memory-records.js";
import { boundEntries, clippedText, inactiveSection } from "./projection.js";

type Source = LongTermMemoryProvenance | LearningMemorySource;

function projectSource(source: Source) {
  if (source.kind === "manual") return { kind: source.kind, source: source.source };
  if (source.kind === "passive_response") return {
    kind: source.kind, sourceSessionId: source.sourceSessionId, sourceRequestId: source.sourceRequestId,
    ...("certainty" in source ? { certainty: source.certainty, observedAt: source.observedAt } : {}),
  };
  return { kind: source.kind, environmentId: source.environmentId, deviceId: source.deviceId,
    batchId: source.batchId, observationIds: source.observationIds.slice(0, 4),
    omittedObservationIds: Math.max(0, source.observationIds.length - 4),
    observedAt: source.observedAt, certainty: source.certainty };
}

/** Source identity only; no content classification or special session-name rules. */
function origin(source: Source | undefined): string {
  if (!source) return "unspecified";
  if (source.kind === "manual") return JSON.stringify([source.kind, source.source]);
  if (source.kind === "passive_response") return JSON.stringify([source.kind, source.sourceSessionId]);
  return JSON.stringify([source.kind, source.environmentId, source.deviceId]);
}

function savedEntry(record: LongTermMemoryRecord, family: "saved" | "passive") {
  const observations = record.observationSources ?? [];
  return { id: record.id, family, status: "saved", content: clippedText(record.content, 350),
    certainty: record.provenance.kind === "passive_observation" ? record.provenance.certainty : "unspecified",
    provenance: projectSource(record.provenance),
    ...(observations.length ? { observationSources: observations.slice(-2).map(projectSource),
      omittedObservationSources: Math.max(0, observations.length - 2) } : {}),
    updatedAt: record.updatedAt };
}

function candidateEntry(record: LearningCandidateRecord) {
  return { id: record.id, revision: record.revision, family: "candidate", status: "candidate_not_saved",
    content: clippedText(record.content, 350), certainty: record.certainty,
    sources: record.sources.slice(-2).map(projectSource), omittedSources: Math.max(0, record.sources.length - 2),
    updatedAt: record.updatedAt, expiresAt: record.expiresAt };
}

function interleave<T>(groups: readonly (readonly T[])[]): T[] {
  return Array.from({ length: Math.max(0, ...groups.map(group => group.length)) }, (_, index) =>
    groups.flatMap(group => group[index] === undefined ? [] : [group[index]!])).flat();
}

function diversify<T>(records: readonly T[], source: (record: T) => Source | undefined, project: (record: T) => ReferenceEntry) {
  const groups = new Map<string, ReferenceEntry[]>();
  for (const record of records) {
    const key = origin(source(record));
    const entries = groups.get(key) ?? [];
    entries.push(project(record));
    groups.set(key, entries);
  }
  return interleave([...groups.values()]);
}

export function projectPlanningMemories(snapshot: CapturedMemoryRecords) {
  if (!snapshot.enabled) return { section: inactiveSection("disabled", "long_term_memory_disabled"),
    sourceStatus: { saved: "disabled", passive: "disabled", candidates: "disabled" } };
  const families = [
    diversify(snapshot.saved.records, record => record.provenance, record => savedEntry(record, "saved")).slice(0, limits.savedMemories),
    diversify(snapshot.passive.records, record => record.provenance, record => savedEntry(record, "passive")).slice(0, limits.passiveMemories),
    diversify(snapshot.candidates.records, record => record.sources.at(-1), candidateEntry).slice(0, limits.candidates),
  ];
  const availableCount = snapshot.saved.availableCount + snapshot.passive.availableCount + snapshot.candidates.availableCount;
  const scannedCount = snapshot.saved.records.length + snapshot.passive.records.length + snapshot.candidates.records.length;
  const omittedByFamilyCount = scannedCount - families.reduce((count, family) => count + family.length, 0);
  const section = boundEntries(interleave(families), limits.savedMemories + limits.passiveMemories + limits.candidates,
    limits.planningMemoryCharacters, {
      availableCount, scannedCount,
      selection: "interleaved_memory_families_and_exact_provenance_origins; significance_is_not_inferred_from_presence",
    });
  const omittedByCount = (section.omittedByCount ?? 0) + omittedByFamilyCount;
  const omittedOutsideWindow = Math.max(0, availableCount - scannedCount);
  return {
    section: { ...section, omittedByCount, omittedOutsideWindow,
      omittedCount: omittedByCount + omittedOutsideWindow + (section.omittedByBudget ?? 0),
      excludedExpiredCandidates: snapshot.candidates.excludedExpiredCount },
    sourceStatus: { saved: snapshot.saved.availableCount ? "available" : "empty",
      passive: snapshot.passive.availableCount ? "available" : "empty",
      candidates: snapshot.candidates.availableCount ? "available" : "empty" },
  };
}
