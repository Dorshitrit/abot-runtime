import { isRuntimeDelegateRoleId, RUNTIME_ROOT_ROLE_ID } from "../../roles.js";
import { resetRoleCapabilitySelectionSupervisionState } from "../capability-selection-supervision.js";
import type {
  OpenChildRoleCallCommand,
  ReturnChildRoleCallCommand,
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallResult,
  RoleCallState,
  RoleCallTransitionResult,
  RoleCallWorkerCapabilityScope,
} from "../contracts.js";
import {
  bindRoleCallPlanChild,
  plannerPlanHasOpenItems,
  settleRoleCallPlanChild,
} from "../plan.js";
import {
  areOwnedDependencyResults,
  commit,
  findCall,
  isBoundedText,
  reject,
} from "../reducer-primitives.js";
import { isRoleCallWorkingDirectoryRoleId } from "../working-directory.js";
import { nextCallId, replaceCall } from "./call-frame-state.js";

export function openChild(
  state: RoleCallState,
  command: OpenChildRoleCallCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const {
    callerCallId,
    objective,
    workerCapabilityScope,
    workingDirectory,
    dependencyResultRefs = [],
    plannerPlan,
  } = command;
  const roleId: string = command.roleId;
  if (state.phase === "empty") {
    return reject(state, "root_missing");
  }
  if (roleId === RUNTIME_ROOT_ROLE_ID) {
    return reject(state, "supervisor_child_forbidden");
  }
  if (!isRuntimeDelegateRoleId(roleId)) {
    return reject(state, "invalid_command");
  }
  if (!policy.authority.availableSubordinateContractIds.includes(roleId)) {
    return reject(state, "child_role_not_authorized");
  }
  if (!isWorkerCapabilityScopeAllowedForRole(roleId, workerCapabilityScope)) {
    return reject(state, "invalid_command");
  }
  if (!isWorkingDirectoryAllowedForRole(roleId, workingDirectory)) {
    return reject(state, "invalid_command");
  }
  const caller = findActiveChildCaller(state, callerCallId);
  if (!caller) {
    return reject(state, "caller_not_active");
  }
  if (!isBoundedText(objective, policy.limits.maxObjectiveChars)) {
    return reject(state, "invalid_command");
  }
  if (!areOwnedDependencyResults(state, caller, dependencyResultRefs)) {
    return reject(state, "child_dependency_invalid");
  }
  const depth = caller.depth + 1;
  if (depth > policy.limits.maxDepth) {
    return reject(state, "depth_limit_exceeded");
  }
  if (state.calls.length >= policy.limits.maxCalls) {
    return reject(state, "call_limit_exceeded");
  }

  const childCallId = nextCallId(state);
  const planBinding = bindRoleCallPlanChild({
    state,
    caller,
    childCallId,
    childObjective: objective,
    ...(plannerPlan ? { binding: plannerPlan } : {}),
    policy,
  });
  if (!planBinding.ok) {
    return reject(state, planBinding.code, planBinding.issues);
  }
  const child: RoleCallFrame = {
    callId: childCallId,
    parentCallId: callerCallId,
    roleId,
    depth,
    objective: objective.trim(),
    ...(workerCapabilityScope ? { workerCapabilityScope } : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    dependencyResultRefs: [...dependencyResultRefs],
    status: "active",
    childCallIds: [],
    activationCount: 1,
    resultRef: null,
  };
  return commit(
    {
      ...state,
      activeCallId: childCallId,
      callSequence: state.callSequence + 1,
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
      plans: planBinding.plans,
      calls: [
        ...replaceCall(state.calls, {
          ...caller,
          status: "waiting_for_child",
          childCallIds: [...caller.childCallIds, childCallId],
        }),
        child,
      ],
    },
    {
      type: "child_opened",
      callerCallId,
      childCallId,
      ...(planBinding.planItemIds
        ? { planItemIds: planBinding.planItemIds }
        : {}),
    },
  );
}

export function returnChild(
  state: RoleCallState,
  command: ReturnChildRoleCallCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callerCallId, childCallId, outcome, summary } = command;
  if (state.phase === "empty") {
    return reject(state, "root_missing");
  }
  const matchedReturn = findMatchingActiveChildReturn(
    state,
    callerCallId,
    childCallId,
  );
  if (!matchedReturn) {
    return reject(state, "child_return_mismatch");
  }
  const { caller, child } = matchedReturn;
  if (!hasValidChildReturnPayload(child, outcome, summary, policy)) {
    return reject(state, "invalid_command");
  }
  const resultRef = nextResultRef(state);
  const result: RoleCallResult = {
    resultRef,
    producerCallId: childCallId,
    roleId: child.roleId,
    outcome,
    summary: summary.trim(),
  };
  if (hasIncompleteCompletedPlannerPlan(state, child, outcome)) {
    return reject(state, "planner_plan_incomplete");
  }
  const planSettlement = settleRoleCallPlanChild({
    state,
    caller,
    childCallId,
    outcome,
  });
  if (!planSettlement.ok) {
    return reject(state, planSettlement.code);
  }
  return commit(
    {
      ...state,
      activeCallId: callerCallId,
      resultSequence: state.resultSequence + 1,
      capabilitySelectionSupervision:
        resetRoleCapabilitySelectionSupervisionState(),
      plans: planSettlement.plans,
      calls: replaceCall(
        replaceCall(state.calls, {
          ...caller,
          status: "active",
          activationCount: caller.activationCount + 1,
        }),
        {
          ...child,
          status: "completed",
          resultRef,
        },
      ),
      results: [...state.results, result],
    },
    {
      type: "child_returned",
      callerCallId,
      childCallId,
      resultRef,
      ...(planSettlement.planItemIds
        ? { planItemIds: planSettlement.planItemIds }
        : {}),
    },
  );
}

function nextResultRef(state: RoleCallState): string {
  return `result-${state.resultSequence + 1}`;
}

function isWorkerCapabilityScopeAllowedForRole(
  roleId: string,
  workerCapabilityScope: RoleCallWorkerCapabilityScope | undefined,
): boolean {
  if (!workerCapabilityScope) return true;
  return roleId === "worker";
}

function isWorkingDirectoryAllowedForRole(
  roleId: string,
  workingDirectory: string | undefined,
): boolean {
  if (workingDirectory === undefined) return true;
  return isRoleCallWorkingDirectoryRoleId(roleId);
}

function findActiveChildCaller(
  state: RoleCallState,
  callerCallId: string,
): RoleCallFrame | undefined {
  if (state.phase !== "running") return undefined;
  if (state.activeCallId !== callerCallId) return undefined;
  const caller = findCall(state, callerCallId);
  if (caller?.status !== "active") return undefined;
  return caller;
}

type MatchingActiveChildReturn = Readonly<{
  caller: RoleCallFrame;
  child: RoleCallFrame;
}>;

function findMatchingActiveChildReturn(
  state: RoleCallState,
  callerCallId: string,
  childCallId: string,
): MatchingActiveChildReturn | undefined {
  if (state.phase !== "running") return undefined;
  if (state.activeCallId !== childCallId) return undefined;
  const child = findCall(state, childCallId);
  if (child?.status !== "active") return undefined;
  if (child.parentCallId !== callerCallId) return undefined;
  const caller = findCall(state, callerCallId);
  if (caller?.status !== "waiting_for_child") return undefined;
  if (!caller.childCallIds.includes(childCallId)) return undefined;
  return { caller, child };
}

type ReturnableChildFrame = RoleCallFrame &
  Readonly<{
    roleId: Exclude<RoleCallFrame["roleId"], typeof RUNTIME_ROOT_ROLE_ID>;
  }>;

function hasValidChildReturnPayload(
  child: RoleCallFrame,
  outcome: ReturnChildRoleCallCommand["outcome"],
  summary: string,
  policy: RoleCallPolicy,
): child is ReturnableChildFrame {
  if (child.roleId === RUNTIME_ROOT_ROLE_ID) return false;
  if (outcome !== "completed" && outcome !== "failed") return false;
  return isBoundedText(summary, policy.limits.maxResultChars);
}

function hasIncompleteCompletedPlannerPlan(
  state: RoleCallState,
  child: RoleCallFrame,
  outcome: ReturnChildRoleCallCommand["outcome"],
): boolean {
  if (child.roleId !== "planner") return false;
  if (outcome !== "completed") return false;
  return plannerPlanHasOpenItems(state.plans, child.callId);
}
