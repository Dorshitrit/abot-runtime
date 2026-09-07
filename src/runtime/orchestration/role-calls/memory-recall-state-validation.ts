import { RUNTIME_ROOT_ROLE_ID } from "../roles.js";
import type {
  RoleCallFrame,
  RoleCallState,
  RoleCallValidationIssue,
} from "./contracts.js";
import type { RoleMemoryRecall } from "./memory-recall-contract.js";
import {
  hasMemoryRecallIdentity,
  isBoundedMemoryRecallQuery,
  normalizeRoleMemoryRecallResult,
} from "./memory-recall-decoder.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";

export function validateRoleMemoryRecalls(
  state: RoleCallState,
): RoleCallValidationIssue[] {
  const invalid = [
    { code: "invalid_role_memory_recalls", path: "state.memoryRecalls" },
  ];
  if (!Array.isArray(state.memoryRecalls)) return invalid;
  const root = state.calls.find((call) => call.callId === state.rootCallId);
  if (!root) return state.memoryRecalls.length === 0 ? [] : invalid;
  let previousAttempt = 0;
  let previousSteeringVersion = 0;
  let previousCompletedChildCount = 0;
  let pendingCount = 0;
  for (const [index, recall] of state.memoryRecalls.entries()) {
    if (
      !isOrderedRootMemoryRecall(
        recall,
        root,
        index,
        previousAttempt,
        previousSteeringVersion,
        previousCompletedChildCount,
      )
    )
      return invalid;
    previousAttempt = recall.invocationAttempt;
    previousSteeringVersion = recall.steeringVersion;
    previousCompletedChildCount = recall.completedChildCount;
    if (!isMemoryRecallSettlementBound(state, root, recall, index))
      return invalid;
    pendingCount += recall.status === "pending" ? 1 : 0;
  }
  if (hasUnboundMemoryWait(state, pendingCount)) return invalid;
  return [];
}

function isOrderedRootMemoryRecall(
  recall: unknown,
  root: RoleCallFrame,
  index: number,
  previousAttempt: number,
  previousSteeringVersion: number,
  previousCompletedChildCount: number,
): recall is RoleMemoryRecall {
  if (!isRecord(recall)) return false;
  if (!hasMemoryRecallIdentity(recall)) return false;
  if (
    !exactKeys(
      recall,
      [
        "recallId",
        "completedChildCount",
        "callId",
        "invocationAttempt",
        "steeringVersion",
        "query",
        "status",
      ],
      ["result"],
    )
  )
    return false;
  if (recall.recallId !== `recall-${index + 1}`) return false;
  if (recall.callId !== root.callId) return false;
  if (root.roleId !== RUNTIME_ROOT_ROLE_ID) return false;
  if (root.parentCallId !== null) return false;
  if (recall.invocationAttempt <= previousAttempt) return false;
  if (recall.steeringVersion < previousSteeringVersion) return false;
  if (
    !hasOrderedMemoryRecallChildAnchor(
      recall.completedChildCount,
      root,
      previousCompletedChildCount,
    )
  )
    return false;
  if (!isBoundedMemoryRecallQuery(recall.query)) return false;
  return recall.query === recall.query.trim();
}

function hasOrderedMemoryRecallChildAnchor(
  value: unknown,
  root: RoleCallFrame,
  previousCompletedChildCount: number,
): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  if (value < 0) return false;
  if (value < previousCompletedChildCount) return false;
  return value <= root.childCallIds.length;
}

function isMemoryRecallSettlementBound(
  state: RoleCallState,
  root: RoleCallFrame,
  recall: RoleMemoryRecall,
  index: number,
): boolean {
  if (recall.status === "pending")
    return isPendingMemoryRecallBound(state, root, recall, index);
  if (recall.status !== "settled") return false;
  if (recall.invocationAttempt >= root.activationCount) return false;
  return normalizeRoleMemoryRecallResult(recall.result) !== undefined;
}

function isPendingMemoryRecallBound(
  state: RoleCallState,
  root: RoleCallFrame,
  recall: RoleMemoryRecall,
  index: number,
): boolean {
  if (index !== state.memoryRecalls.length - 1) return false;
  if (recall.result !== undefined) return false;
  if (recall.invocationAttempt !== root.activationCount) return false;
  if (recall.completedChildCount !== root.childCallIds.length) return false;
  if (state.phase !== "running") return false;
  if (state.activeCallId !== root.callId) return false;
  return root.status === "waiting_for_memory";
}

export function hasSettledMemoryRecallActivationRange(
  state: RoleCallState,
  callId: string,
  fromActivation: number,
  toActivation: number,
): boolean {
  if (toActivation < fromActivation) return false;
  const recalls = state.memoryRecalls.filter((recall) =>
    isSettledMemoryRecallWithinRange(
      recall,
      callId,
      fromActivation,
      toActivation,
    ),
  );
  if (recalls.length !== toActivation - fromActivation) return false;
  return recalls.every(
    (recall, index) => recall.invocationAttempt === fromActivation + index,
  );
}

function isSettledMemoryRecallWithinRange(
  recall: RoleMemoryRecall,
  callId: string,
  fromActivation: number,
  toActivation: number,
): boolean {
  if (recall.callId !== callId) return false;
  if (recall.status !== "settled") return false;
  if (recall.invocationAttempt < fromActivation) return false;
  return recall.invocationAttempt < toActivation;
}

function hasUnboundMemoryWait(
  state: RoleCallState,
  pendingCount: number,
): boolean {
  const waitingCalls = state.calls.filter(
    (call) => call.status === "waiting_for_memory",
  );
  if (waitingCalls.length !== pendingCount) return true;
  return waitingCalls.some((call) => call.callId !== state.rootCallId);
}
