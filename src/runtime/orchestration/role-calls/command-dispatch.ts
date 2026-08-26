import {
  isRuntimeDelegateRoleId,
  RUNTIME_ROOT_ROLE_ID,
  RUNTIME_ROLE_IDS,
} from "../roles.js";
import {
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../capability-adapters/result.js";
import {
  createRoleCapabilitySelectionFingerprint,
  normalizeRoleCapabilitySelectionProjection,
} from "./capability-selection-reconsideration.js";
import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_EXECUTION_LIMIT_MAX,
  ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH,
  ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  ROLE_CALL_LEDGER_CONTRACT_VERSION,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallCommitEffect,
  type RoleCallFrame,
  type RoleCallLedgerCommand,
  type RoleCallPlanBinding,
  type RoleCallPolicy,
  type RoleCallPolicyInput,
  type RoleCallResult,
  type RoleCallState,
  type RoleCallWorkerCapabilityScope,
  type RoleCallTransitionRejectionCode,
  type RoleCallTransitionResult,
  type RoleCallValidationIssue,
  type RoleCapabilityDeclaredEffect,
  type RoleCapabilityObservationBatchEntry,
  type RoleCapabilityBatchSettlement,
  type RoleCapabilityExecution,
  type RoleCapabilityExecutionOutcome,
  type RoleCapabilityObservedEffect,
  type RoleCapabilityResultReference,
  type RoleCapabilitySelectionProjection,
  type RoleCapabilitySelectionReconsideration,
} from "./contracts.js";
import {
  bindRoleCallPlanChild,
  parseRoleCallPlanBinding,
  plannerPlanHasOpenItems,
  settleRoleCallPlanChild,
  validateRoleCallPlans,
} from "./plan.js";
import {
  isRoleCallWorkerCapabilityScope,
  parseRoleCallWorkerCapabilityScope,
} from "./worker-capability-scope.js";
import {
  isRoleCallWorkingDirectoryRoleId,
  normalizeEstablishedRoleCallWorkingDirectory,
  normalizeRoleCallWorkingDirectory,
} from "./working-directory.js";

import { hasCapabilityAuthority } from "./candidate-validation.js";
import {
  areOwnedDependencyResults,
  commit,
  findCall,
  isBoundedText,
  isExactJsonObjectString,
  isExactResultValidForCall,
  isOptionalBoundedText,
  isRoleCapabilityDeclaredEffect,
  isSettledObservedEffectCompatible,
  isUniqueStringArray,
  isValidCapabilityResultReferences,
  reject,
  sameStringArray,
} from "./reducer-primitives.js";

type RoleCallCommandOf<TType extends RoleCallLedgerCommand["type"]> = Extract<
  RoleCallLedgerCommand,
  { type: TType }
>;

export function dispatchRoleCallCommand(
  state: RoleCallState,
  command: RoleCallLedgerCommand,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  switch (command.type) {
    case "create_root":
      return createRoot(state);
    case "complete_root_response":
      return completeRootResponse(state, command, policy);
    case "open_child":
      return openChild(state, command, policy);
    case "return_child":
      return returnChild(state, command, policy);
    case "begin_capability_execution":
      return beginCapabilityExecution(state, command, policy);
    case "settle_capability_execution":
      return settleCapabilityExecution(state, command, policy);
    case "begin_capability_batch":
      return beginCapabilityBatch(state, command, policy);
    case "settle_capability_batch":
      return settleCapabilityBatch(state, command, policy);
    case "update_capability_scope":
      return updateCapabilityScope(state, command, policy);
    case "establish_working_directory":
      return establishWorkingDirectory(state, command, policy);
    case "reconsider_capability_selection":
      return reconsiderCapabilitySelection(state, command, policy);
  }
}

function createRoot(state: RoleCallState): RoleCallTransitionResult {
  if (state.phase !== "empty" || state.rootCallId !== null) {
    return reject(state, "root_already_created");
  }
  const callId = nextCallId(state);
  const root: RoleCallFrame = {
    callId,
    parentCallId: null,
    roleId: RUNTIME_ROOT_ROLE_ID,
    depth: 0,
    objective: null,
    dependencyResultRefs: [],
    status: "active",
    childCallIds: [],
    activationCount: 1,
    resultRef: null,
  };
  return commit(
    {
      ...state,
      phase: "running",
      rootCallId: callId,
      activeCallId: callId,
      callSequence: state.callSequence + 1,
      calls: [...state.calls, root],
    },
    { type: "root_created", callId },
  );
}

function completeRootResponse(
  state: RoleCallState,
  command: RoleCallCommandOf<"complete_root_response">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, response } = command;
  if (state.phase === "empty") {
    return reject(state, "root_missing");
  }
  const root = findCall(state, callId);
  if (
    state.phase !== "running" ||
    callId !== state.rootCallId ||
    state.activeCallId !== callId ||
    root?.roleId !== RUNTIME_ROOT_ROLE_ID ||
    root.status !== "active"
  ) {
    return reject(state, "root_response_not_allowed");
  }
  if (!isBoundedText(response, policy.limits.maxResponseChars)) {
    return reject(state, "invalid_command");
  }
  return commit(
    {
      ...state,
      phase: "completed",
      activeCallId: null,
      rootResponse:
        policy.authority.terminalTextMode === "exact"
          ? response
          : response.trim(),
      calls: replaceCall(state.calls, {
        ...root,
        status: "completed",
      }),
    },
    { type: "root_response_committed", callId },
  );
}

function establishWorkingDirectory(
  state: RoleCallState,
  command: RoleCallCommandOf<"establish_working_directory">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, workingDirectory } = command;
  const call = findCall(state, callId);
  if (
    state.phase !== "running" ||
    state.activeCallId !== callId ||
    !hasCapabilityAuthority(policy.authority, state, call) ||
    call.status !== "active" ||
    call.activationCount !== invocationAttempt ||
    call.workingDirectory !== undefined
  ) {
    return reject(state, "working_directory_establishment_invalid");
  }
  const normalized =
    normalizeEstablishedRoleCallWorkingDirectory(workingDirectory);
  if (!normalized) {
    return reject(state, "working_directory_establishment_invalid");
  }
  return commit(
    {
      ...state,
      calls: replaceCall(state.calls, {
        ...call,
        workingDirectory: normalized,
      }),
    },
    { type: "working_directory_established", callId },
  );
}

function reconsiderCapabilitySelection(
  state: RoleCallState,
  command: RoleCallCommandOf<"reconsider_capability_selection">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, steeringVersion, selection } = command;
  const call = findCall(state, callId);
  const activeScope = call?.workerCapabilityScope?.catalogGroupIds;
  if (
    state.phase !== "running" ||
    state.activeCallId !== callId ||
    !hasCapabilityAuthority(policy.authority, state, call) ||
    call.status !== "active" ||
    call.activationCount !== invocationAttempt ||
    !activeScope ||
    !sameStringArray(activeScope, selection.activeCapabilityCatalogGroupIds) ||
    (call.workingDirectory !== undefined &&
      selection.workingDirectory !== call.workingDirectory) ||
    !Number.isSafeInteger(steeringVersion) ||
    steeringVersion < 0
  ) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  const normalizedSelection =
    normalizeRoleCapabilitySelectionProjection(selection);
  if (!normalizedSelection) {
    return reject(state, "capability_selection_reconsideration_invalid");
  }
  const fingerprint = createRoleCapabilitySelectionFingerprint({
    steeringVersion,
    selection: normalizedSelection,
  });
  const reconsideration: RoleCapabilitySelectionReconsideration = {
    invocationAttempt,
    steeringVersion,
    fingerprint,
    selection: normalizedSelection,
  };
  return commit(
    {
      ...state,
      calls: replaceCall(state.calls, {
        ...call,
        activationCount: call.activationCount + 1,
        lastCapabilitySelectionReconsideration: reconsideration,
      }),
    },
    {
      type: "capability_selection_reconsidered",
      callId,
      invocationAttempt,
      fingerprint,
    },
  );
}

function openChild(
  state: RoleCallState,
  command: RoleCallCommandOf<"open_child">,
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
  if (workerCapabilityScope && roleId !== "worker") {
    return reject(state, "invalid_command");
  }
  if (
    workingDirectory !== undefined &&
    !isRoleCallWorkingDirectoryRoleId(roleId)
  ) {
    return reject(state, "invalid_command");
  }
  const caller = findCall(state, callerCallId);
  if (
    state.phase !== "running" ||
    state.activeCallId !== callerCallId ||
    caller?.status !== "active"
  ) {
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

function returnChild(
  state: RoleCallState,
  command: RoleCallCommandOf<"return_child">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callerCallId, childCallId, outcome, summary } = command;
  if (state.phase === "empty") {
    return reject(state, "root_missing");
  }
  const caller = findCall(state, callerCallId);
  const child = findCall(state, childCallId);
  if (
    state.phase !== "running" ||
    state.activeCallId !== childCallId ||
    child?.status !== "active" ||
    child.parentCallId !== callerCallId ||
    caller?.status !== "waiting_for_child" ||
    !caller.childCallIds.includes(childCallId)
  ) {
    return reject(state, "child_return_mismatch");
  }
  if (
    child.roleId === RUNTIME_ROOT_ROLE_ID ||
    (outcome !== "completed" && outcome !== "failed") ||
    !isBoundedText(summary, policy.limits.maxResultChars)
  ) {
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
  if (
    child.roleId === "planner" &&
    outcome === "completed" &&
    plannerPlanHasOpenItems(state.plans, child.callId)
  ) {
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

function beginCapabilityExecution(
  state: RoleCallState,
  command: RoleCallCommandOf<"begin_capability_execution">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const {
    callId,
    invocationAttempt,
    capabilityId,
    declaredEffect,
    intent,
    controlsJson,
  } = command;
  const call = findCall(state, callId);
  if (
    state.phase !== "running" ||
    state.activeCallId !== callId ||
    !hasCapabilityAuthority(policy.authority, state, call) ||
    call.status !== "active"
  ) {
    return reject(state, "capability_caller_invalid");
  }
  if (call.activationCount !== invocationAttempt) {
    return reject(state, "capability_invocation_mismatch");
  }
  if (
    !isRoleCapabilityId(capabilityId) ||
    !isRoleCapabilityDeclaredEffect(declaredEffect) ||
    !isBoundedText(intent, ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH) ||
    !isExactJsonObjectString(controlsJson)
  ) {
    return reject(state, "invalid_command");
  }
  if (
    state.capabilityExecutions.length >= policy.limits.maxCapabilityExecutions
  ) {
    return reject(state, "capability_execution_limit_exceeded");
  }

  const executionId = nextCapabilityExecutionId(state);
  const execution: RoleCapabilityExecution = {
    executionId,
    callId,
    invocationAttempt,
    capabilityId,
    declaredEffect,
    intent: intent.trim(),
    controlsJson,
    status: "running",
    outcome: null,
    observedEffect: null,
    summary: null,
  };
  return commit(
    {
      ...state,
      capabilityExecutionSequence: state.capabilityExecutionSequence + 1,
      calls: replaceCall(state.calls, {
        ...call,
        status: "waiting_for_capability",
      }),
      capabilityExecutions: [...state.capabilityExecutions, execution],
    },
    {
      type: "capability_execution_begun",
      callId,
      executionId,
    },
  );
}

function settleCapabilityExecution(
  state: RoleCallState,
  command: RoleCallCommandOf<"settle_capability_execution">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const {
    callId,
    executionId,
    outcome,
    observedEffect,
    summary,
    referenceData,
    references,
    exactResult,
  } = command;
  const call = findCall(state, callId);
  const execution = findCapabilityExecution(state, executionId);
  const ownedRunning = state.capabilityExecutions.filter(
    (candidate) =>
      candidate.callId === callId && candidate.status === "running",
  );
  if (
    state.phase !== "running" ||
    state.activeCallId !== callId ||
    !hasCapabilityAuthority(policy.authority, state, call) ||
    call.status !== "waiting_for_capability" ||
    execution?.status !== "running" ||
    execution.callId !== callId ||
    execution.invocationAttempt !== call.activationCount ||
    ownedRunning.length !== 1
  ) {
    return reject(state, "capability_execution_mismatch");
  }
  if (
    !isBoundedText(summary, policy.limits.maxResultChars) ||
    !isOptionalBoundedText(
      referenceData,
      ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
    ) ||
    !isValidCapabilityResultReferences(references) ||
    !isExactResultValidForCall(call, exactResult) ||
    (outcome !== "succeeded" && outcome !== "failed") ||
    !isSettledObservedEffectCompatible({
      declaredEffect: execution.declaredEffect,
      outcome,
      observedEffect,
    })
  ) {
    return reject(state, "capability_execution_mismatch");
  }

  return commit(
    {
      ...state,
      calls: replaceCall(state.calls, {
        ...call,
        status: "active",
        activationCount: call.activationCount + 1,
      }),
      capabilityExecutions: replaceCapabilityExecution(
        state.capabilityExecutions,
        {
          ...execution,
          status: "settled",
          outcome,
          observedEffect,
          summary: summary.trim(),
          ...(referenceData ? { referenceData } : {}),
          ...(references && references.length > 0
            ? { references: Object.freeze([...references]) }
            : {}),
          exactResult,
        },
      ),
    },
    {
      type: "capability_execution_settled",
      callId,
      executionId,
    },
  );
}

function beginCapabilityBatch(
  state: RoleCallState,
  command: RoleCallCommandOf<"begin_capability_batch">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, entries } = command;
  const call = findCall(state, callId);
  if (
    state.phase !== "running" ||
    state.activeCallId !== callId ||
    !hasCapabilityAuthority(policy.authority, state, call) ||
    call.status !== "active"
  ) {
    return reject(state, "capability_caller_invalid");
  }
  if (call.activationCount !== invocationAttempt) {
    return reject(state, "capability_invocation_mismatch");
  }
  if (
    !Array.isArray(entries) ||
    entries.length < 2 ||
    entries.some(
      (entry) =>
        !isRoleCapabilityId(entry.capabilityId) ||
        entry.declaredEffect !== "observation" ||
        !isBoundedText(
          entry.intent,
          ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH,
        ) ||
        !isExactJsonObjectString(entry.controlsJson),
    )
  ) {
    return reject(state, "invalid_command");
  }
  if (
    state.capabilityExecutions.length + entries.length >
    policy.limits.maxCapabilityExecutions
  ) {
    return reject(state, "capability_execution_limit_exceeded");
  }

  const executions = entries.map(
    (entry, index): RoleCapabilityExecution => ({
      executionId: nextCapabilityExecutionId(state, index),
      callId,
      invocationAttempt,
      capabilityId: entry.capabilityId,
      declaredEffect: "observation",
      intent: entry.intent.trim(),
      controlsJson: entry.controlsJson,
      status: "running",
      outcome: null,
      observedEffect: null,
      summary: null,
    }),
  );
  const executionIds = Object.freeze(
    executions.map((execution) => execution.executionId),
  );
  return commit(
    {
      ...state,
      capabilityExecutionSequence:
        state.capabilityExecutionSequence + executions.length,
      calls: replaceCall(state.calls, {
        ...call,
        status: "waiting_for_capability",
      }),
      capabilityExecutions: [...state.capabilityExecutions, ...executions],
    },
    {
      type: "capability_batch_begun",
      callId,
      executionIds,
    },
  );
}

function updateCapabilityScope(
  state: RoleCallState,
  command: RoleCallCommandOf<"update_capability_scope">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, invocationAttempt, mode, catalogGroupIds } = command;
  const call = findCall(state, callId);
  if (
    state.phase !== "running" ||
    state.activeCallId !== callId ||
    !hasCapabilityAuthority(policy.authority, state, call) ||
    call.status !== "active"
  ) {
    return reject(state, "capability_caller_invalid");
  }
  if (call.activationCount !== invocationAttempt) {
    return reject(state, "capability_invocation_mismatch");
  }

  const requestedScope = parseRoleCallWorkerCapabilityScope({
    catalogGroupIds,
  });
  if (!requestedScope) {
    return reject(state, "invalid_command");
  }
  let nextScope: RoleCallWorkerCapabilityScope;
  if (mode === "open") {
    if (call.workerCapabilityScope !== undefined) {
      return reject(state, "capability_scope_update_invalid");
    }
    nextScope = requestedScope;
  } else {
    const currentScope = call.workerCapabilityScope;
    if (
      !currentScope ||
      requestedScope.catalogGroupIds.some((groupId) =>
        currentScope.catalogGroupIds.includes(groupId),
      )
    ) {
      return reject(state, "capability_scope_update_invalid");
    }
    const extendedScope = parseRoleCallWorkerCapabilityScope({
      catalogGroupIds: [
        ...currentScope.catalogGroupIds,
        ...requestedScope.catalogGroupIds,
      ],
    });
    if (!extendedScope) {
      return reject(state, "capability_scope_update_invalid");
    }
    nextScope = extendedScope;
  }

  return commit(
    {
      ...state,
      calls: replaceCall(state.calls, {
        ...call,
        workerCapabilityScope: nextScope,
        activationCount: call.activationCount + 1,
      }),
    },
    {
      type: "capability_scope_updated",
      callId,
      mode,
      catalogGroupIds: nextScope.catalogGroupIds,
    },
  );
}

function settleCapabilityBatch(
  state: RoleCallState,
  command: RoleCallCommandOf<"settle_capability_batch">,
  policy: RoleCallPolicy,
): RoleCallTransitionResult {
  const { callId, settlements } = command;
  const call = findCall(state, callId);
  const ownedRunning = state.capabilityExecutions.filter(
    (execution) =>
      execution.callId === callId && execution.status === "running",
  );
  if (
    state.phase !== "running" ||
    state.activeCallId !== callId ||
    !hasCapabilityAuthority(policy.authority, state, call) ||
    call.status !== "waiting_for_capability" ||
    ownedRunning.length < 2 ||
    settlements.length !== ownedRunning.length ||
    settlements.some(
      (settlement, index) =>
        settlement.executionId !== ownedRunning[index]?.executionId,
    )
  ) {
    return reject(state, "capability_execution_mismatch");
  }
  for (let index = 0; index < settlements.length; index += 1) {
    const settlement = settlements[index]!;
    const execution = ownedRunning[index]!;
    if (
      execution.invocationAttempt !== call.activationCount ||
      execution.declaredEffect !== "observation" ||
      !isBoundedText(settlement.summary, policy.limits.maxResultChars) ||
      !isOptionalBoundedText(
        settlement.referenceData,
        ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
      ) ||
      !isValidCapabilityResultReferences(settlement.references) ||
      !isExactResultValidForCall(call, settlement.exactResult) ||
      (settlement.outcome !== "succeeded" && settlement.outcome !== "failed") ||
      !isSettledObservedEffectCompatible({
        declaredEffect: execution.declaredEffect,
        outcome: settlement.outcome,
        observedEffect: settlement.observedEffect,
      })
    ) {
      return reject(state, "capability_execution_mismatch");
    }
  }

  const byExecutionId = new Map(
    settlements.map((settlement) => [settlement.executionId, settlement]),
  );
  return commit(
    {
      ...state,
      calls: replaceCall(state.calls, {
        ...call,
        status: "active",
        activationCount: call.activationCount + 1,
      }),
      capabilityExecutions: state.capabilityExecutions.map((execution) => {
        const settlement = byExecutionId.get(execution.executionId);
        return settlement
          ? {
              ...execution,
              status: "settled" as const,
              outcome: settlement.outcome,
              observedEffect: settlement.observedEffect,
              summary: settlement.summary.trim(),
              ...(settlement.referenceData
                ? { referenceData: settlement.referenceData }
                : {}),
              ...(settlement.references && settlement.references.length > 0
                ? {
                    references: Object.freeze([...settlement.references]),
                  }
                : {}),
              exactResult: settlement.exactResult,
            }
          : execution;
      }),
    },
    {
      type: "capability_batch_settled",
      callId,
      executionIds: Object.freeze(
        settlements.map((settlement) => settlement.executionId),
      ),
    },
  );
}

type ParsedCommand =
  | Readonly<{ ok: true; value: RoleCallLedgerCommand }>
  | Readonly<{
      ok: false;
      code: "invalid_command" | "supervisor_child_forbidden";
    }>;

function replaceCall(
  calls: readonly RoleCallFrame[],
  replacement: RoleCallFrame,
): RoleCallFrame[] {
  return calls.map((call) =>
    call.callId === replacement.callId ? replacement : call,
  );
}

function findCapabilityExecution(
  state: RoleCallState,
  executionId: string,
): RoleCapabilityExecution | undefined {
  return state.capabilityExecutions.find(
    (execution) => execution.executionId === executionId,
  );
}

function replaceCapabilityExecution(
  executions: readonly RoleCapabilityExecution[],
  replacement: RoleCapabilityExecution,
): RoleCapabilityExecution[] {
  return executions.map((execution) =>
    execution.executionId === replacement.executionId ? replacement : execution,
  );
}

function nextCallId(state: RoleCallState): string {
  return `call-${state.callSequence + 1}`;
}

function nextResultRef(state: RoleCallState): string {
  return `result-${state.resultSequence + 1}`;
}

function nextCapabilityExecutionId(state: RoleCallState, offset = 0): string {
  return `capability-execution-${state.capabilityExecutionSequence + offset + 1}`;
}
