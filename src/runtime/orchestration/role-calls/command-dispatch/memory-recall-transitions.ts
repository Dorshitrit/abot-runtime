import { RUNTIME_ROOT_ROLE_ID } from "../../roles.js";
import type {
  RoleCallFrame,
  RoleCallState,
  RoleCallTransitionResult,
} from "../contracts.js";
import type {
  BeginRoleMemoryRecallCommand,
  RoleMemoryRecall,
  SettleRoleMemoryRecallCommand,
} from "../memory-recall-contract.js";
import { commit, reject } from "../reducer-primitives.js";
import { replaceCall } from "./call-frame-state.js";

export function beginMemoryRecall(
  state: RoleCallState,
  command: BeginRoleMemoryRecallCommand,
): RoleCallTransitionResult {
  const call = findMemoryRecallRoot(state, command.callId);
  if (!call || call.status !== "active")
    return reject(state, "memory_recall_caller_invalid");
  if (call.activationCount !== command.invocationAttempt)
    return reject(state, "memory_recall_invocation_mismatch");
  const previous = state.memoryRecalls.at(-1);
  if (previous && command.steeringVersion < previous.steeringVersion)
    return reject(state, "memory_recall_invocation_mismatch");
  const recall: RoleMemoryRecall = {
    recallId: `recall-${state.memoryRecalls.length + 1}`,
    completedChildCount: call.childCallIds.length,
    callId: call.callId,
    invocationAttempt: command.invocationAttempt,
    steeringVersion: command.steeringVersion,
    query: command.query,
    status: "pending",
  };
  return commit(
    {
      ...state,
      calls: replaceCall(state.calls, {
        ...call,
        status: "waiting_for_memory",
      }),
      memoryRecalls: [...state.memoryRecalls, recall],
    },
    {
      type: "memory_recall_begun",
      callId: call.callId,
      recallId: recall.recallId,
      invocationAttempt: recall.invocationAttempt,
      steeringVersion: recall.steeringVersion,
    },
  );
}

export function settleMemoryRecall(
  state: RoleCallState,
  command: SettleRoleMemoryRecallCommand,
): RoleCallTransitionResult {
  const call = findMemoryRecallRoot(state, command.callId);
  if (!call || call.status !== "waiting_for_memory")
    return reject(state, "memory_recall_caller_invalid");
  const pending = state.memoryRecalls.at(-1);
  if (!matchesPendingMemoryRecall(pending, call, command))
    return reject(state, "memory_recall_settlement_mismatch");
  const settled: RoleMemoryRecall = {
    ...pending,
    status: "settled",
    result: command.result,
  };
  return commit(
    {
      ...state,
      calls: replaceCall(state.calls, {
        ...call,
        status: "active",
        activationCount: call.activationCount + 1,
      }),
      memoryRecalls: [...state.memoryRecalls.slice(0, -1), settled],
    },
    {
      type: "memory_recall_settled",
      callId: call.callId,
      recallId: settled.recallId,
      invocationAttempt: settled.invocationAttempt,
      steeringVersion: settled.steeringVersion,
    },
  );
}

function findMemoryRecallRoot(
  state: RoleCallState,
  callId: string,
): RoleCallFrame | undefined {
  if (state.phase !== "running") return undefined;
  if (state.rootCallId !== callId || state.activeCallId !== callId)
    return undefined;
  const call = state.calls.find((candidate) => candidate.callId === callId);
  if (call?.parentCallId !== null) return undefined;
  if (call.roleId !== RUNTIME_ROOT_ROLE_ID) return undefined;
  return call;
}

function matchesPendingMemoryRecall(
  pending: RoleMemoryRecall | undefined,
  call: RoleCallFrame,
  command: SettleRoleMemoryRecallCommand,
): pending is RoleMemoryRecall & { status: "pending" } {
  if (pending?.status !== "pending") return false;
  if (pending.recallId !== command.recallId) return false;
  if (pending.callId !== command.callId) return false;
  if (pending.invocationAttempt !== command.invocationAttempt) return false;
  if (call.activationCount !== command.invocationAttempt) return false;
  return pending.steeringVersion === command.steeringVersion;
}
