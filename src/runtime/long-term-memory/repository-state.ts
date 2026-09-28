import type {
  LongTermMemoryRecord,
  LongTermMemoryRepositorySnapshot,
  LongTermMemoryRepositoryState,
  MemoryVectorIndexEntry,
} from "./contracts.js";
import {
  parseObservationSource,
  parseObservationReceipts,
  parseObservationSources,
} from "./observation-state.js";
import { normalizeMaturationPolicy } from "./maturation/retention.js";
import type { MaturationPolicy } from "./maturation/contracts.js";
import { parseLearningCandidates, parseLearningReceipts } from "./maturation/state.js";

export function createEmptyMemorySnapshot(): LongTermMemoryRepositorySnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: 0,
    records: Object.freeze([]),
    vectors: Object.freeze([]),
  });
}

export function advanceMemorySnapshot(
  current: LongTermMemoryRepositorySnapshot,
  state: LongTermMemoryRepositoryState,
): LongTermMemoryRepositorySnapshot {
  return freezeMemorySnapshot({
    schemaVersion: resolveMemorySchemaVersion(current, state),
    revision: current.revision + 1,
    knowledgeRevision: (current.knowledgeRevision ?? current.revision) + (hasMemoryKnowledgeChanged(current, state) ? 1 : 0),
    records: state.records,
    vectors: state.vectors,
    ...preserveLearningState(current, state),
    ...((state.observationReceipts ?? current.observationReceipts)
      ? {
          observationReceipts:
            state.observationReceipts ?? current.observationReceipts,
        }
      : {}),
  });
}

export function parseMemorySnapshot(
  value: unknown,
): LongTermMemoryRepositorySnapshot {
  const root = readRecord(value, "long_term_memory_store_corrupt");
  // Version 2 belonged to an unsupported QA prototype; never reinterpret it.
  if (
    !isSupportedMemorySchema(root.schemaVersion) ||
    !isNonNegativeInteger(root.revision)
  ) {
    throw new Error("long_term_memory_store_schema_unsupported");
  }
  if (!Array.isArray(root.records) || !Array.isArray(root.vectors)) {
    throw new Error("long_term_memory_store_corrupt");
  }
  return freezeMemorySnapshot({
    schemaVersion: root.schemaVersion,
    revision: root.revision,
    ...(root.knowledgeRevision === undefined ? {} : { knowledgeRevision: readKnowledgeRevision(root.knowledgeRevision) }),
    ...(root.maturationPolicy === undefined ? {} : { maturationPolicy: parseMaturationPolicy(root.maturationPolicy) }),
    records: root.records.map(parseMemoryRecord),
    vectors: root.vectors.map(parseVectorEntry),
    ...(root.learningCandidates === undefined ? {} : { learningCandidates: parseLearningCandidates(root.learningCandidates, root.schemaVersion) }),
    ...(root.learningReceipts === undefined ? {} : { learningReceipts: parseLearningReceipts(root.learningReceipts) }),
    ...(root.observationReceipts === undefined
      ? {}
      : {
          observationReceipts: parseObservationReceipts(
            root.observationReceipts,
          ),
        }),
  });
}

function freezeMemorySnapshot(
  snapshot: LongTermMemoryRepositorySnapshot,
): LongTermMemoryRepositorySnapshot {
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    ...(snapshot.knowledgeRevision === undefined ? {} : { knowledgeRevision: snapshot.knowledgeRevision }),
    ...(snapshot.maturationPolicy ? { maturationPolicy: normalizeMaturationPolicy(snapshot.maturationPolicy) } : {}),
    records: Object.freeze(snapshot.records.map(freezeRecord)),
    vectors: Object.freeze(snapshot.vectors.map(freezeVectorEntry)),
    ...(snapshot.learningCandidates ? { learningCandidates: parseLearningCandidates(snapshot.learningCandidates, snapshot.schemaVersion) } : {}),
    ...(snapshot.learningReceipts ? { learningReceipts: parseLearningReceipts(snapshot.learningReceipts) } : {}),
    ...(snapshot.observationReceipts
      ? {
          observationReceipts: parseObservationReceipts(
            snapshot.observationReceipts,
          ),
        }
      : {}),
  });
}

export function parseMemoryRecord(value: unknown): LongTermMemoryRecord {
  const record = readRecord(value, "long_term_memory_record_corrupt");
  const tags = readStringArray(record.tags, "long_term_memory_tags_corrupt");
  return freezeRecord({
    id: readString(record.id),
    content: readString(record.content),
    tags,
    provenance: parseProvenance(record.provenance),
    createdAt: readTimestamp(record.createdAt),
    updatedAt: readTimestamp(record.updatedAt),
    ...parseAutomaticManagement(record.automaticManagement),
    ...(record.reconsiderAt === undefined ? {} : { reconsiderAt: record.reconsiderAt === null ? null : readTimestamp(record.reconsiderAt) }),
    ...(record.observationSources === undefined
      ? {}
      : {
          observationSources: parseObservationSources(
            record.observationSources,
          ),
        }),
  });
}

function isSupportedMemorySchema(value: unknown): value is 1 | 3 | 4 | 5 {
  return value === 1 || value === 3 || value === 4 || value === 5;
}

function resolveMemorySchemaVersion(current: LongTermMemoryRepositorySnapshot, state: LongTermMemoryRepositoryState): 1 | 3 | 4 | 5 {
  if (current.schemaVersion === 5 || state.maturationPolicy) return 5;
  if (state.learningCandidates?.some((record) => record.reinforcements || record.replacement || record.sources.some((source) => source.kind === "passive_response"))) return 5;
  if (current.schemaVersion === 4 || state.learningCandidates || state.learningReceipts) return 4;
  if (state.records.some((record) => record.automaticManagement !== undefined || record.reconsiderAt !== undefined)) return 4;
  if (hasObservationMemoryState(state) || current.schemaVersion === 3) return 3;
  return 1;
}

function preserveLearningState(current: LongTermMemoryRepositorySnapshot, state: LongTermMemoryRepositoryState) {
  const maturationPolicy = state.maturationPolicy ?? current.maturationPolicy;
  const learningCandidates = state.learningCandidates ?? current.learningCandidates;
  const learningReceipts = state.learningReceipts ?? current.learningReceipts;
  return {
    ...(maturationPolicy ? { maturationPolicy } : {}),
    ...(learningCandidates ? { learningCandidates } : {}),
    ...(learningReceipts ? { learningReceipts } : {}),
  };
}

function parseAutomaticManagement(value: unknown): Pick<LongTermMemoryRecord, "automaticManagement"> {
  if (value === undefined) return {};
  if (value === "allowed" || value === "protected") return { automaticManagement: value };
  throw new Error("long_term_memory_protection_corrupt");
}

function hasMemoryKnowledgeChanged(current: LongTermMemoryRepositorySnapshot, state: LongTermMemoryRepositoryState): boolean {
  if (current.records.length !== state.records.length) return true;
  if (state.records.some((record, index) => JSON.stringify(record) !== JSON.stringify(current.records[index]))) return true;
  const candidates = state.learningCandidates ?? current.learningCandidates ?? [];
  const previous = current.learningCandidates ?? [];
  if (candidates.length !== previous.length) return true;
  return candidates.some((candidate, index) => candidate.id !== previous[index]?.id || candidate.revision !== previous[index]?.revision);
}

function readKnowledgeRevision(value: unknown): number {
  if (!isNonNegativeInteger(value)) throw new Error("long_term_memory_knowledge_revision_corrupt");
  return value;
}

function parseProvenance(value: unknown): LongTermMemoryRecord["provenance"] {
  const provenance = readRecord(value, "long_term_memory_provenance_corrupt");
  if (provenance.kind === "passive_observation")
    return parseObservationSource(provenance);
  if (provenance.kind === "passive_response") {
    return Object.freeze({
      kind: "passive_response" as const,
      sourceSessionId: readString(provenance.sourceSessionId),
      sourceRequestId: readString(provenance.sourceRequestId),
    });
  }
  const source = provenance.source;
  const validManualSource = source === "web_ui" || source === "management_api";
  if (provenance.kind === "manual" && validManualSource) {
    return Object.freeze({
      kind: "manual" as const,
      source,
    });
  }
  throw new Error("long_term_memory_provenance_corrupt");
}

function parseVectorEntry(value: unknown): MemoryVectorIndexEntry {
  const entry = readRecord(value, "long_term_memory_vector_corrupt");
  if (!isPositiveInteger(entry.dimensions) || !Array.isArray(entry.vector)) {
    throw new Error("long_term_memory_vector_corrupt");
  }
  const vector = entry.vector.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
  if (
    vector.length !== entry.vector.length ||
    vector.length !== entry.dimensions
  ) {
    throw new Error("long_term_memory_vector_corrupt");
  }
  return freezeVectorEntry({
    memoryId: readString(entry.memoryId),
    modelFingerprint: readString(entry.modelFingerprint),
    dimensions: entry.dimensions,
    vector,
  });
}

function freezeRecord(record: LongTermMemoryRecord): LongTermMemoryRecord {
  return Object.freeze({
    ...record,
    tags: Object.freeze([...record.tags]),
    provenance: Object.freeze({ ...record.provenance }),
  });
}

function freezeVectorEntry(
  entry: MemoryVectorIndexEntry,
): MemoryVectorIndexEntry {
  return Object.freeze({
    ...entry,
    vector: Object.freeze([...entry.vector]),
  });
}

function readRecord(
  value: unknown,
  errorCode: string,
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(errorCode);
}

function readString(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error("long_term_memory_store_corrupt");
}

function readTimestamp(value: unknown): string {
  const timestamp = readString(value);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error("long_term_memory_store_corrupt");
  }
  return timestamp;
}

function readStringArray(value: unknown, errorCode: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(errorCode);
  }
  return [...value] as string[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasObservationMemoryState(
  state: LongTermMemoryRepositoryState,
): boolean {
  if (state.observationReceipts?.length) return true;
  return state.records.some(
    (record) =>
      record.provenance.kind === "passive_observation" ||
      (record.observationSources?.length ?? 0) > 0,
  );
}

function parseMaturationPolicy(value: unknown): MaturationPolicy {
  const policy = readRecord(value, "learning_maturation_policy_invalid");
  return normalizeMaturationPolicy({
    promotionScore: policy.promotionScore as number, retentionDays: policy.retentionDays as number,
    maxCandidates: policy.maxCandidates as number, maxBytes: policy.maxBytes as number,
  });
}
