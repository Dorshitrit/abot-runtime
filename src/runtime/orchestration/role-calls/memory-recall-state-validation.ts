import {
  isAssistantToolCallMessage, isStrictTextChatMessage, isToolResultMessage,
} from "../../../model-gateway/message-contract.js";
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

/** The existing checkpoint carries this passive startup field, never a model action. */
export function hasInitialMemoryContext(value: unknown, policyId: string): boolean {
  if (value === undefined) return true;
  if (policyId !== "execution-agent-v1" && policyId !== "supervisor-worker-v1") return false;
  if (!isRecord(value) || !exactKeys(value, [], ["message", "knowledge"])) return false;
  if (value.message !== undefined && !isInitialMemoryMessage(value.message)) return false;
  if (value.knowledge === undefined) return true;
  return isInitialMemoryKnowledge(value.knowledge);
}

function isInitialMemoryMessage(value: unknown): boolean {
  if (isStrictTextChatMessage(value)) return true;
  if (isAssistantToolCallMessage(value)) return true;
  return isToolResultMessage(value);
}

function isInitialMemoryKnowledge(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind !== "learning_knowledge_reference_v1") return false;
  if (value.authority !== "passive_reference") return false;
  if (value.presenceEffect !== "does_not_authorize_actions_or_add_user_intent") return false;
  if (!isMemoryRevision(value.repositoryRevision)) return false;
  if (!isMemoryRevision(value.knowledgeRevision)) return false;
  if (!isMemoryRevision(value.omitted)) return false;
  if (typeof value.referenceTime !== "string" || !Number.isFinite(Date.parse(value.referenceTime))) return false;
  if (!Array.isArray(value.entries) || value.entries.length > 12) return false;
  if (!value.entries.every(isInitialMemoryKnowledgeEntry)) return false;
  const identities = value.entries.map(entry => JSON.stringify([entry.kind, entry.id]));
  return new Set(identities).size === identities.length;
}

function isMemoryRevision(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  return value >= 0;
}

function isInitialMemoryKnowledgeEntry(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.kind !== "candidate" && value.kind !== "memory") return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.version !== "string" || value.version.length === 0) return false;
  if (typeof value.content !== "string") return false;
  if (!Array.isArray(value.tags) || !value.tags.every(tag => typeof tag === "string")) return false;
  if (typeof value.mutable !== "boolean") return false;
  if (value.score !== null && !isMemoryScore(value.score)) return false;
  if (value.reason !== null && typeof value.reason !== "string") return false;
  if (!["observed", "inferred", "unspecified"].includes(value.certainty as string)) return false;
  if (!isOptionalMemoryTime(value.lastReinforcedAt)) return false;
  return isOptionalMemoryTime(value.reconsiderAt);
}

function isMemoryScore(value: unknown): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return value >= 0 && value <= 100;
}

function isOptionalMemoryTime(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  return Number.isFinite(Date.parse(value));
}
