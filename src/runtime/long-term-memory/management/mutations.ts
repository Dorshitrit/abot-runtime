import { randomUUID } from "node:crypto";

import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRecord,
  LongTermMemoryRepository,
  MemoryClearResult,
  MemoryVectorIndexEntry,
} from "../contracts.js";
import type {
  LongTermMemoryManagementContext,
  MemoryCreateInput,
  MemoryCreateResult,
  MemoryDeleteInput,
  MemoryDeleteResult,
  MemoryUpdateInput,
  MemoryUpdateResult,
} from "./contracts.js";
import { LongTermMemoryManagementError } from "./errors.js";
import { clearMemoryRecords } from "./queries.js";
import {
  findExactMemoryDuplicate,
  normalizeMemoryId,
  prepareCreatedMemory,
  prepareUpdatedMemory,
} from "./validation.js";

type EmbeddingBatch = Awaited<
  ReturnType<LongTermMemoryEmbeddingClient["embed"]>
>;

export async function createManagedMemory(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  input: MemoryCreateInput;
  now?: () => Date;
  createId?: () => string;
}): Promise<MemoryCreateResult> {
  const prepared = prepareCreatedMemory(params.input);
  const initial = await params.repository.read();
  const initialDuplicate = findExactMemoryDuplicate(
    initial.records,
    prepared.candidate.content,
  );
  if (initialDuplicate) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_duplicate",
      { memoryId: initialDuplicate.id },
    );
  }
  const embedded = await embedContent({
    embeddings: params.embeddings,
    content: prepared.candidate.content,
    context: params.input.context,
  });
  const timestamp = readTimestamp(params.now);
  const id = normalizeMemoryId((params.createId ?? randomUUID)());
  const record = freezeMemoryRecord({
    id,
    content: prepared.candidate.content,
    tags: prepared.candidate.tags,
    provenance: Object.freeze({
      kind: "manual" as const,
      source: prepared.source,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await params.repository.update((current) => {
    params.input.context.abortSignal.throwIfAborted();
    const duplicate = findExactMemoryDuplicate(current.records, record.content);
    if (duplicate) {
      throw new LongTermMemoryManagementError(
        "long_term_memory_management_duplicate",
        { memoryId: duplicate.id },
      );
    }
    if (current.records.some((existing) => existing.id === record.id)) {
      throw new LongTermMemoryManagementError(
        "long_term_memory_management_conflict",
        { memoryId: record.id },
      );
    }
    return {
      records: Object.freeze([...current.records, record]),
      vectors: Object.freeze([
        ...current.vectors,
        createVectorEntry(record.id, embedded),
      ]),
    };
  });
  return Object.freeze({ record });
}

export async function updateManagedMemory(params: {
  repository: LongTermMemoryRepository;
  embeddings: LongTermMemoryEmbeddingClient;
  input: MemoryUpdateInput;
  now?: () => Date;
}): Promise<MemoryUpdateResult> {
  const prepared = prepareUpdatedMemory(params.input);
  const initial = await findUpdateTarget(params.repository, prepared);
  if (matchesCandidate(initial, prepared.candidate)) {
    return Object.freeze({ record: initial, updated: false });
  }
  const contentChanged = initial.content !== prepared.candidate.content;
  const embedded = contentChanged
    ? await embedContent({
        embeddings: params.embeddings,
        content: prepared.candidate.content,
        context: params.input.context,
      })
    : undefined;
  let updatedRecord: LongTermMemoryRecord | undefined;
  await params.repository.update((current) => {
    params.input.context.abortSignal.throwIfAborted();
    const target = requireCurrentUpdateTarget(current.records, prepared);
    const duplicate = findExactMemoryDuplicate(
      current.records,
      prepared.candidate.content,
      target.id,
    );
    if (duplicate) {
      throw new LongTermMemoryManagementError(
        "long_term_memory_management_duplicate",
        { memoryId: duplicate.id },
      );
    }
    updatedRecord = freezeMemoryRecord({
      ...target,
      content: prepared.candidate.content,
      tags: prepared.candidate.tags,
      updatedAt: nextTimestamp(target.updatedAt, params.now),
    });
    return {
      records: Object.freeze(
        current.records.map((record) =>
          record.id === target.id ? updatedRecord! : record,
        ),
      ),
      vectors: embedded
        ? replaceMemoryVector(
            current.vectors,
            createVectorEntry(target.id, embedded),
          )
        : current.vectors,
    };
  });
  return Object.freeze({ record: updatedRecord!, updated: true });
}

export async function deleteManagedMemory(
  repository: LongTermMemoryRepository,
  input: MemoryDeleteInput,
): Promise<MemoryDeleteResult> {
  const id = normalizeMemoryId(input.id);
  const current = await repository.read();
  if (!current.records.some((record) => record.id === id)) {
    return Object.freeze({ deleted: false });
  }
  let deleted = false;
  await repository.update((snapshot) => {
    const containsTarget = snapshot.records.some((record) => record.id === id);
    if (!containsTarget) {
      return { records: snapshot.records, vectors: snapshot.vectors };
    }
    deleted = true;
    return {
      records: Object.freeze(
        snapshot.records.filter((record) => record.id !== id),
      ),
      vectors: Object.freeze(
        snapshot.vectors.filter((entry) => entry.memoryId !== id),
      ),
    };
  });
  return Object.freeze({ deleted });
}

export function clearManagedMemories(
  repository: LongTermMemoryRepository,
): Promise<MemoryClearResult> {
  return clearMemoryRecords(repository);
}

async function findUpdateTarget(
  repository: LongTermMemoryRepository,
  prepared: Readonly<{ id: string; expectedUpdatedAt: string }>,
): Promise<LongTermMemoryRecord> {
  const snapshot = await repository.read();
  return requireCurrentUpdateTarget(snapshot.records, prepared);
}

function requireCurrentUpdateTarget(
  records: readonly LongTermMemoryRecord[],
  prepared: Readonly<{ id: string; expectedUpdatedAt: string }>,
): LongTermMemoryRecord {
  const target = records.find((record) => record.id === prepared.id);
  if (!target) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_not_found",
      { memoryId: prepared.id },
    );
  }
  if (target.updatedAt !== prepared.expectedUpdatedAt) {
    throw new LongTermMemoryManagementError(
      "long_term_memory_management_conflict",
      { memoryId: prepared.id },
    );
  }
  return target;
}

function matchesCandidate(
  record: LongTermMemoryRecord,
  candidate: Readonly<{ content: string; tags: readonly string[] }>,
): boolean {
  return (
    record.content === candidate.content &&
    record.tags.length === candidate.tags.length &&
    record.tags.every((tag, index) => tag === candidate.tags[index])
  );
}

async function embedContent(params: {
  embeddings: LongTermMemoryEmbeddingClient;
  content: string;
  context: LongTermMemoryManagementContext;
}): Promise<EmbeddingBatch> {
  params.context.abortSignal.throwIfAborted();
  const embedded = await params.embeddings.embed({
    texts: [params.content],
    abortSignal: params.context.abortSignal,
    ...(params.context.debugRequestId
      ? { debugRequestId: params.context.debugRequestId }
      : {}),
  });
  params.context.abortSignal.throwIfAborted();
  const vector = embedded.vectors[0];
  const validVector =
    embedded.vectors.length === 1 &&
    embedded.dimensions > 0 &&
    vector?.length === embedded.dimensions &&
    vector.every(Number.isFinite);
  if (!validVector || !embedded.modelFingerprint.trim()) {
    throw new Error("long_term_memory_embedding_response_invalid");
  }
  return embedded;
}

function createVectorEntry(
  memoryId: string,
  embedded: EmbeddingBatch,
): MemoryVectorIndexEntry {
  return Object.freeze({
    memoryId,
    modelFingerprint: embedded.modelFingerprint,
    dimensions: embedded.dimensions,
    vector: Object.freeze([...embedded.vectors[0]!]),
  });
}

function replaceMemoryVector(
  vectors: readonly MemoryVectorIndexEntry[],
  replacement: MemoryVectorIndexEntry,
): readonly MemoryVectorIndexEntry[] {
  return Object.freeze([
    ...vectors.filter((entry) => entry.memoryId !== replacement.memoryId),
    replacement,
  ]);
}

function readTimestamp(now: (() => Date) | undefined): string {
  return (now ?? (() => new Date()))().toISOString();
}

function nextTimestamp(
  previous: string,
  now: (() => Date) | undefined,
): string {
  const current = readTimestamp(now);
  if (Date.parse(current) > Date.parse(previous)) {
    return current;
  }
  return new Date(Date.parse(previous) + 1).toISOString();
}

function freezeMemoryRecord(
  record: LongTermMemoryRecord,
): LongTermMemoryRecord {
  return Object.freeze({
    ...record,
    tags: Object.freeze([...record.tags]),
    provenance: Object.freeze({ ...record.provenance }),
  });
}
