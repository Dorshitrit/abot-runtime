import type {
  LongTermMemoryRecord,
  LongTermMemoryRetrieval,
} from "./contracts.js";
import {
  ROLE_MEMORY_RECALL_RECORD_LIMIT_MAX,
  ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH,
  type RoleMemoryRecallResult,
} from "../orchestration/role-calls/memory-recall-contract.js";
import { classifyMemoryFailure } from "./diagnostics.js";
import { parseMemoryRecord } from "./repository-state.js";

/** Retain whole canonical records; never truncate a stored fact into a new fact. */
export function boundMemoryRecallResult(
  retrieval: LongTermMemoryRetrieval,
): RoleMemoryRecallResult {
  if (!retrieval.available) {
    return unavailableMemoryRecall(
      classifyMemoryFailure(new Error(retrieval.reason)),
    );
  }
  if (retrieval.records.length === 0) {
    return Object.freeze({
      outcome: "empty",
      records: Object.freeze([]),
      omittedRecordCount: 0,
    });
  }
  const records: LongTermMemoryRecord[] = [];
  const retainedRecordIds = new Set<string>();
  for (const source of retrieval.records) {
    if (records.length >= ROLE_MEMORY_RECALL_RECORD_LIMIT_MAX) break;
    const record = parseMemoryRecord(source);
    const hasRetainedRecordId = retainedRecordIds.has(record.id);
    if (hasRetainedRecordId) continue;
    const candidate = foundMemoryRecall(
      [...records, record],
      retrieval.records.length - records.length - 1,
    );
    if (!fitsMemoryRecallResult(candidate)) continue;
    records.push(record);
    retainedRecordIds.add(record.id);
  }
  const omittedRecordCount = retrieval.records.length - records.length;
  if (records.length === 0) {
    return unavailableMemoryRecall(
      "memory_recall_result_exceeds_budget",
      omittedRecordCount,
    );
  }
  return foundMemoryRecall(records, omittedRecordCount);
}

export function unavailableMemoryRecall(
  reason: string,
  omittedRecordCount = 0,
): RoleMemoryRecallResult {
  return Object.freeze({
    outcome: "unavailable",
    records: Object.freeze([]),
    omittedRecordCount,
    reason,
  });
}

function foundMemoryRecall(
  records: readonly LongTermMemoryRecord[],
  omittedRecordCount: number,
): RoleMemoryRecallResult {
  return Object.freeze({
    outcome: "found",
    records: Object.freeze([...records]),
    omittedRecordCount,
  });
}

function fitsMemoryRecallResult(result: RoleMemoryRecallResult): boolean {
  return JSON.stringify(result).length <= ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH;
}
