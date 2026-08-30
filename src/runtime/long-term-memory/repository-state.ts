import type {
  LongTermMemoryRecord,
  LongTermMemoryRepositorySnapshot,
  LongTermMemoryRepositoryState,
  MemoryVectorIndexEntry,
} from "./contracts.js";

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
    schemaVersion: 1,
    revision: current.revision + 1,
    records: state.records,
    vectors: state.vectors,
  });
}

export function parseMemorySnapshot(
  value: unknown,
): LongTermMemoryRepositorySnapshot {
  const root = readRecord(value, "long_term_memory_store_corrupt");
  if (root.schemaVersion !== 1 || !isNonNegativeInteger(root.revision)) {
    throw new Error("long_term_memory_store_schema_unsupported");
  }
  if (!Array.isArray(root.records) || !Array.isArray(root.vectors)) {
    throw new Error("long_term_memory_store_corrupt");
  }
  return freezeMemorySnapshot({
    schemaVersion: 1,
    revision: root.revision,
    records: root.records.map(parseRecord),
    vectors: root.vectors.map(parseVectorEntry),
  });
}

function freezeMemorySnapshot(
  snapshot: LongTermMemoryRepositorySnapshot,
): LongTermMemoryRepositorySnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: snapshot.revision,
    records: Object.freeze(snapshot.records.map(freezeRecord)),
    vectors: Object.freeze(snapshot.vectors.map(freezeVectorEntry)),
  });
}

function parseRecord(value: unknown): LongTermMemoryRecord {
  const record = readRecord(value, "long_term_memory_record_corrupt");
  const tags = readStringArray(record.tags, "long_term_memory_tags_corrupt");
  return freezeRecord({
    id: readString(record.id),
    content: readString(record.content),
    tags,
    provenance: parseProvenance(record.provenance),
    createdAt: readTimestamp(record.createdAt),
    updatedAt: readTimestamp(record.updatedAt),
  });
}

function parseProvenance(value: unknown): LongTermMemoryRecord["provenance"] {
  const provenance = readRecord(value, "long_term_memory_provenance_corrupt");
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
