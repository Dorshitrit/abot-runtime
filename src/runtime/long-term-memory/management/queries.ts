import type {
  LongTermMemoryRepository,
  LongTermMemoryStatus,
  MemoryClearResult,
} from "../contracts.js";
import { classifyMemoryFailure } from "../diagnostics.js";
import type { MemoryListInput, MemoryListResult } from "./contracts.js";
import { normalizeMemoryPage } from "./validation.js";

export async function readMemoryStatus(params: {
  repository: LongTermMemoryRepository;
  enabled: boolean;
}): Promise<LongTermMemoryStatus> {
  try {
    const snapshot = await params.repository.read();
    return Object.freeze({
      enabled: params.enabled,
      available: true,
      recordCount: snapshot.records.length,
      indexedRecordCount: new Set(
        snapshot.vectors.map(({ memoryId }) => memoryId),
      ).size,
      ...(!params.enabled ? { reason: "disabled" } : {}),
    });
  } catch (error) {
    return Object.freeze({
      enabled: params.enabled,
      available: false,
      recordCount: 0,
      indexedRecordCount: 0,
      reason: classifyMemoryFailure(error),
    });
  }
}

export async function listMemoryRecords(
  repository: LongTermMemoryRepository,
  input: MemoryListInput = {},
): Promise<MemoryListResult> {
  const snapshot = await repository.read();
  const page = normalizeMemoryPage(input);
  return Object.freeze({
    items: Object.freeze(
      snapshot.records.slice(page.offset, page.offset + page.limit),
    ),
    total: snapshot.records.length,
  });
}

export async function clearMemoryRecords(
  repository: LongTermMemoryRepository,
): Promise<MemoryClearResult> {
  const observed = await repository.read();
  if (observed.records.length === 0 && observed.vectors.length === 0) {
    return Object.freeze({ deletedCount: 0 });
  }
  let deletedCount = 0;
  await repository.update((current) => {
    deletedCount = current.records.length;
    return {
      records: Object.freeze([]),
      vectors: Object.freeze([]),
    };
  });
  return Object.freeze({ deletedCount });
}
