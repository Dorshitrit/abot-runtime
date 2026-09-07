import { parseMemoryRecord } from "../../long-term-memory/repository-state.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";
import type { DecodedRoleCallCommand } from "./command-decoder.js";
import {
  ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH,
  ROLE_MEMORY_RECALL_REASON_MAX_LENGTH,
  ROLE_MEMORY_RECALL_RECORD_LIMIT_MAX,
  ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH,
  type RoleMemoryRecallIdentity,
  type RoleMemoryRecallResult,
} from "./memory-recall-contract.js";

export function decodeMemoryRecallCommand(
  input: Record<string, unknown>,
): DecodedRoleCallCommand {
  const invalid = { ok: false, code: "invalid_command" } as const;
  if (!hasMemoryRecallIdentity(input)) return invalid;
  if (input.type === "begin_memory_recall")
    return decodeBeginMemoryRecall(input);
  return decodeSettleMemoryRecall(input);
}

function decodeBeginMemoryRecall(
  input: Record<string, unknown> & RoleMemoryRecallIdentity,
): DecodedRoleCallCommand {
  const invalid = { ok: false, code: "invalid_command" } as const;
  if (input.authority !== "active_role") return invalid;
  if (
    !exactKeys(input, [
      "authority",
      "type",
      "callId",
      "invocationAttempt",
      "steeringVersion",
      "query",
    ])
  )
    return invalid;
  if (!isBoundedMemoryRecallQuery(input.query)) return invalid;
  return {
    ok: true,
    value: {
      authority: "active_role",
      type: "begin_memory_recall",
      callId: input.callId,
      invocationAttempt: input.invocationAttempt,
      steeringVersion: input.steeringVersion,
      query: input.query.trim(),
    },
  };
}

function decodeSettleMemoryRecall(
  input: Record<string, unknown> & RoleMemoryRecallIdentity,
): DecodedRoleCallCommand {
  const invalid = { ok: false, code: "invalid_command" } as const;
  if (input.type !== "settle_memory_recall") return invalid;
  if (input.authority !== "runtime") return invalid;
  if (
    !exactKeys(input, [
      "authority",
      "type",
      "callId",
      "invocationAttempt",
      "steeringVersion",
      "recallId",
      "result",
    ])
  )
    return invalid;
  if (typeof input.recallId !== "string") return invalid;
  const result = normalizeRoleMemoryRecallResult(input.result);
  if (!result) return invalid;
  return {
    ok: true,
    value: {
      authority: "runtime",
      type: "settle_memory_recall",
      callId: input.callId,
      invocationAttempt: input.invocationAttempt,
      steeringVersion: input.steeringVersion,
      recallId: input.recallId,
      result,
    },
  };
}

export function hasMemoryRecallIdentity(
  input: Record<string, unknown>,
): input is Record<string, unknown> & RoleMemoryRecallIdentity {
  if (typeof input.callId !== "string" || input.callId.length === 0)
    return false;
  if (!Number.isSafeInteger(input.invocationAttempt)) return false;
  if ((input.invocationAttempt as number) < 1) return false;
  if (!Number.isSafeInteger(input.steeringVersion)) return false;
  return (input.steeringVersion as number) >= 0;
}

export function isBoundedMemoryRecallQuery(input: unknown): input is string {
  if (typeof input !== "string") return false;
  if (input.trim().length === 0) return false;
  return input.length <= ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH;
}

export function normalizeRoleMemoryRecallResult(
  input: unknown,
): RoleMemoryRecallResult | undefined {
  if (!isRecord(input)) return undefined;
  if (
    !exactKeys(input, ["outcome", "records", "omittedRecordCount"], ["reason"])
  )
    return undefined;
  const outcome = input.outcome;
  if (!isMemoryRecallOutcome(outcome)) return undefined;
  if (!Array.isArray(input.records)) return undefined;
  if (input.records.length > ROLE_MEMORY_RECALL_RECORD_LIMIT_MAX)
    return undefined;
  if (!Number.isSafeInteger(input.omittedRecordCount)) return undefined;
  if ((input.omittedRecordCount as number) < 0) return undefined;
  if (!isMemoryRecallReason(input.reason)) return undefined;
  if (!hasRecordsForMemoryRecallOutcome(outcome, input.records.length))
    return undefined;
  try {
    if (JSON.stringify(input).length > ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH)
      return undefined;
    const records = Object.freeze(input.records.map(parseMemoryRecord));
    if (new Set(records.map((record) => record.id)).size !== records.length)
      return undefined;
    return Object.freeze({
      outcome,
      records,
      omittedRecordCount: input.omittedRecordCount as number,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  } catch {
    return undefined;
  }
}

function isMemoryRecallOutcome(
  input: unknown,
): input is RoleMemoryRecallResult["outcome"] {
  return (
    input === "found" ||
    input === "empty" ||
    input === "unavailable" ||
    input === "superseded"
  );
}

function isMemoryRecallReason(input: unknown): input is string | undefined {
  if (input === undefined) return true;
  if (typeof input !== "string") return false;
  if (input.trim().length === 0) return false;
  return input.length <= ROLE_MEMORY_RECALL_REASON_MAX_LENGTH;
}

function hasRecordsForMemoryRecallOutcome(
  outcome: RoleMemoryRecallResult["outcome"],
  count: number,
): boolean {
  if (outcome === "found") return count > 0;
  return count === 0;
}
