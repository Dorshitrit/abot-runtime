import {
  isRuntimeDelegateRoleId,
  RUNTIME_ROOT_ROLE_ID,
  RUNTIME_ROLE_IDS,
} from "../roles.js";
import {
  createRoleCapabilitySelectionFingerprint,
  normalizeRoleCapabilitySelectionProjection,
} from "./capability-selection-reconsideration.js";
import {
  createRoleCapabilitySelectionSupervisionFingerprint,
  isRoleCapabilitySelectionSupervisionState,
} from "./capability-selection-supervision.js";
import { isIssuedRoleCapabilitySelectionSupervisionState } from "./capability-selection-supervision-issuance.js";
import {
  isRoleOperationFingerprint,
  isRoleOperationOutcomeFingerprintForOutcome,
  isSameRoleOperationIdentity,
  replayRoleOperationSupervisionEvidence,
  type RoleOperationSupervisionEntry,
  type RoleOperationSupervisionInterventionRecord,
  type RoleOperationSupervisionSettlement,
} from "./operation-supervision.js";
import { isIssuedRoleOperationSupervisionInterventionForRequest } from "./operation-supervision-issuance.js";
import {
  isRoleOperationSupervisionSettlementHistoryValid,
  isRoleOperationSupervisionState,
} from "./operation-supervision-state-validation.js";
import { isReconsiderationCauseBoundToInvocationCount } from "./reconsideration-cause.js";
import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_EXECUTION_LIMIT_MAX,
  ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CALL_LEDGER_CONTRACT_VERSION,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallFrame,
  type RoleCallPolicy,
  type RoleCallState,
  type RoleCallValidationIssue,
  type RoleCapabilityExecution,
} from "./contracts.js";
import { validateRoleCallPlans } from "./plan.js";
import { isRoleCallResultReceiptValidForStoredResult } from "./result-receipt.js";
import { findRoleActivationBudgetIssue } from "./activation-budget.js";
import { isRoleCallWorkerCapabilityScope } from "./worker-capability-scope.js";
import {
  isRoleCallWorkingDirectoryRoleId,
  normalizeEstablishedRoleCallWorkingDirectory,
  normalizeRoleCallWorkingDirectory,
} from "./working-directory.js";
import {
  areOwnedDependencyResults,
  exactKeys,
  findCall,
  isBoundedText,
  isCanonicalTerminalText,
  isExactJsonObjectString,
  isExactResultValidForCall,
  isOptionalBoundedText,
  isRecord,
  isRoleCapabilityDeclaredEffect,
  isSettledObservedEffectCompatible,
  isUniqueStringArray,
  isValidCapabilityResultReferences,
  issue,
} from "./reducer-primitives.js";

export function validateRoleCallPolicy(
  policy: RoleCallPolicy,
): RoleCallValidationIssue[] {
  if (!isExecutionPolicyAuthoritySnapshot(policy?.authority)) {
    return [issue("invalid_execution_policy_authority", "policy.authority")];
  }
  const limits = policy?.limits;
  return !limits ||
    !Number.isInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    !Number.isInteger(limits.maxCalls) ||
    limits.maxCalls < 1 ||
    !Number.isInteger(limits.maxCapabilityExecutions) ||
    limits.maxCapabilityExecutions < 1 ||
    limits.maxCapabilityExecutions > ROLE_CAPABILITY_EXECUTION_LIMIT_MAX ||
    !Number.isInteger(limits.maxObjectiveChars) ||
    limits.maxObjectiveChars < 1 ||
    !Number.isInteger(limits.maxResultChars) ||
    limits.maxResultChars < 1 ||
    !Number.isInteger(limits.maxResponseChars) ||
    limits.maxResponseChars < 1
    ? [issue("invalid_role_call_policy", "policy.limits")]
    : [];
}

export function validateRoleCallState(
  state: RoleCallState,
  policy: RoleCallPolicy,
): RoleCallValidationIssue[] {
  const issues: RoleCallValidationIssue[] = [];
  if (
    state?.contractVersion !== ROLE_CALL_LEDGER_CONTRACT_VERSION ||
    !isBoundedText(state?.requestId, 256) ||
    !["empty", "running", "completed"].includes(state?.phase) ||
    !Array.isArray(state?.calls) ||
    !Array.isArray(state?.results) ||
    !Array.isArray(state?.plans) ||
    !Array.isArray(state?.capabilityExecutions) ||
    !isRoleOperationSupervisionState(state?.operationSupervision) ||
    !isRoleCapabilitySelectionSupervisionState(
      state?.capabilitySelectionSupervision,
    ) ||
    !Number.isInteger(state?.callSequence) ||
    !Number.isInteger(state?.resultSequence) ||
    !Number.isInteger(state?.capabilityExecutionSequence) ||
    state.callSequence !== state.calls.length ||
    state.resultSequence !== state.results.length ||
    state.capabilityExecutionSequence !== state.capabilityExecutions.length
  ) {
    return [issue("invalid_role_call_state_shape", "state")];
  }
  if (state.calls.length > policy.limits.maxCalls) {
    issues.push(issue("role_call_count_exceeded", "state.calls"));
  }
  if (
    state.capabilityExecutions.length > policy.limits.maxCapabilityExecutions
  ) {
    issues.push(
      issue(
        "role_capability_execution_count_exceeded",
        "state.capabilityExecutions",
      ),
    );
  }
  const ids = new Set(state.calls.map((call) => call.callId));
  if (ids.size !== state.calls.length) {
    issues.push(issue("duplicate_role_call_id", "state.calls"));
  }
  const root = state.rootCallId
    ? state.calls.find((call) => call.callId === state.rootCallId)
    : undefined;
  const turnOwnerCalls = state.calls.filter(
    (call) =>
      call.status === "active" || call.status === "waiting_for_capability",
  );
  if (state.phase === "empty") {
    if (
      state.rootCallId !== null ||
      state.activeCallId !== null ||
      state.calls.length > 0 ||
      state.results.length > 0 ||
      state.plans.length > 0 ||
      state.capabilityExecutions.length > 0 ||
      state.operationSupervision.entries.length > 0 ||
      state.operationSupervision.interventions.length > 0 ||
      state.capabilitySelectionSupervision.epoch !== null ||
      state.capabilitySelectionSupervision.records.length > 0 ||
      state.rootResponse !== null
    ) {
      issues.push(issue("invalid_empty_role_call_state", "state.phase"));
    }
  } else if (
    !root ||
    root.parentCallId !== null ||
    root.roleId !== RUNTIME_ROOT_ROLE_ID ||
    root.depth !== 0
  ) {
    issues.push(issue("invalid_role_call_root", "state.rootCallId"));
  }
  if (state.phase === "running") {
    if (
      turnOwnerCalls.length !== 1 ||
      turnOwnerCalls[0]?.callId !== state.activeCallId ||
      state.rootResponse !== null
    ) {
      issues.push(issue("invalid_active_role_call", "state.activeCallId"));
    }
  }
  if (
    state.phase === "completed" &&
    (state.activeCallId !== null ||
      root?.status !== "completed" ||
      state.capabilitySelectionSupervision.epoch !== null ||
      state.capabilitySelectionSupervision.records.length > 0 ||
      !isCanonicalTerminalText(
        state.rootResponse,
        policy.limits.maxResponseChars,
        policy.authority.terminalTextMode,
      ))
  ) {
    issues.push(issue("invalid_completed_role_call_state", "state.phase"));
  }
  for (const call of state.calls) {
    if (!isAuthorizedCallFrame(policy.authority, state.rootCallId, call)) {
      issues.push(
        issue(
          "unauthorized_role_call_contract",
          `state.calls.${call.callId}.roleId`,
        ),
      );
    }
    if (
      !RUNTIME_ROLE_IDS.includes(call.roleId) ||
      ![
        "active",
        "waiting_for_child",
        "waiting_for_capability",
        "completed",
      ].includes(call.status) ||
      !Number.isInteger(call.depth) ||
      call.depth < 0 ||
      call.depth > policy.limits.maxDepth ||
      !Number.isInteger(call.activationCount) ||
      call.activationCount < 1 ||
      !Array.isArray(call.childCallIds) ||
      !isUniqueStringArray(call.dependencyResultRefs) ||
      (call.workerCapabilityScope !== undefined &&
        (!hasCapabilityAuthority(policy.authority, state, call) ||
          !isRoleCallWorkerCapabilityScope(call.workerCapabilityScope))) ||
      (call.workingDirectory !== undefined &&
        !isCanonicalRoleCallWorkingDirectory(state, call, policy.authority)) ||
      (call.parentCallId === null
        ? call.objective !== null || call.dependencyResultRefs.length !== 0
        : !isBoundedText(call.objective, policy.limits.maxObjectiveChars)) ||
      !isValidCapabilitySelectionReconsideration(call, policy, state)
    ) {
      issues.push(
        issue("invalid_role_call_frame", `state.calls.${call.callId}`),
      );
      continue;
    }
    if (call.parentCallId !== null) {
      const parent = state.calls.find(
        (candidate) => candidate.callId === call.parentCallId,
      );
      if (
        !parent ||
        call.depth !== parent.depth + 1 ||
        !parent.childCallIds.includes(call.callId)
      ) {
        issues.push(
          issue("invalid_role_call_parent", `state.calls.${call.callId}`),
        );
      }
      if (
        !parent ||
        !areOwnedDependencyResults(
          state,
          parent,
          call.dependencyResultRefs,
          state.calls.indexOf(call),
        )
      ) {
        issues.push(
          issue(
            "invalid_role_call_dependencies",
            `state.calls.${call.callId}.dependencyResultRefs`,
          ),
        );
      }
    }
  }
  const resultRefs = new Set(state.results.map((result) => result.resultRef));
  if (resultRefs.size !== state.results.length) {
    issues.push(issue("duplicate_role_call_result", "state.results"));
  }
  for (const result of state.results) {
    const producer = state.calls.find(
      (call) => call.callId === result.producerCallId,
    );
    if (
      !producer ||
      producer.resultRef !== result.resultRef ||
      producer.status !== "completed" ||
      producer.roleId !== result.roleId ||
      (result.outcome !== "completed" && result.outcome !== "failed") ||
      !isBoundedText(result.summary, policy.limits.maxResultChars) ||
      !isRoleCallResultReceiptValidForStoredResult({
        receipt: result.receipt,
        producer,
        result,
        policy, state,
      })
    ) {
      issues.push(
        issue(
          "invalid_role_call_result_owner",
          `state.results.${result.resultRef}`,
        ),
      );
    }
  }
  issues.push(...validateRoleCallPlans(state, policy));
  validateCapabilityExecutions(state, policy, issues);
  if (!isValidRoleOperationSupervision(state, policy)) {
    issues.push(
      issue("invalid_role_operation_supervision", "state.operationSupervision"),
    );
  }
  if (!isValidRoleCapabilitySelectionSupervision(state, policy)) {
    issues.push(
      issue(
        "invalid_role_capability_selection_supervision",
        "state.capabilitySelectionSupervision",
      ),
    );
  }
  const activationBudgetIssue = findRoleActivationBudgetIssue(state, policy);
  if (activationBudgetIssue) issues.push(activationBudgetIssue);
  return issues;
}

function isValidRoleCapabilitySelectionSupervision(
  state: RoleCallState,
  policy: RoleCallPolicy,
): boolean {
  const supervision = state.capabilitySelectionSupervision;
  if (!isRoleCapabilitySelectionSupervisionState(supervision)) return false;
  if (supervision.epoch === null) return supervision.records.length === 0;
  if (!isIssuedRoleCapabilitySelectionSupervisionState({ state })) return false;
  if (state.phase !== "running" || supervision.records.length < 1) {
    return false;
  }
  const call = findCall(state, supervision.epoch.callId);
  const lastRecord = supervision.records.at(-1);
  const reconsideration = call?.lastCapabilitySelectionReconsideration;
  let expectedSupervisionFingerprint: string | undefined;
  if (reconsideration) {
    try {
      expectedSupervisionFingerprint =
        createRoleCapabilitySelectionSupervisionFingerprint({
          steeringVersion: reconsideration.steeringVersion,
          selection: reconsideration.selection,
        });
    } catch {
      return false;
    }
  }
  if (
    !hasCapabilityAuthority(policy.authority, state, call) ||
    state.activeCallId !== call.callId ||
    call.status !== "active" ||
    !lastRecord ||
    !reconsideration ||
    supervision.epoch.steeringVersion !== reconsideration.steeringVersion ||
    lastRecord.invocationAttempt !== reconsideration.invocationAttempt ||
    lastRecord.receiptFingerprint !== reconsideration.fingerprint ||
    lastRecord.supervisionFingerprint !== expectedSupervisionFingerprint ||
    call.activationCount !== lastRecord.invocationAttempt + 1
  ) {
    return false;
  }
  return supervision.records.every((record, index, records) => {
    const previous = records[index - 1];
    return (
      record.invocationAttempt < call.activationCount &&
      (!previous || record.invocationAttempt === previous.invocationAttempt + 1)
    );
  });
}

function isValidCapabilitySelectionReconsideration(
  call: RoleCallFrame,
  policy: RoleCallPolicy,
  state: RoleCallState,
): boolean {
  const reconsideration = call.lastCapabilitySelectionReconsideration;
  if (reconsideration === undefined) return true;
  if (
    !hasCapabilityAuthority(policy.authority, state, call) ||
    !isRecord(reconsideration) ||
    !exactKeys(reconsideration, [
      "invocationAttempt",
      "steeringVersion",
      "fingerprint",
      "selection",
      "cause",
    ]) ||
    !Number.isSafeInteger(reconsideration.invocationAttempt) ||
    reconsideration.invocationAttempt < 1 ||
    reconsideration.invocationAttempt >= call.activationCount ||
    !Number.isSafeInteger(reconsideration.steeringVersion) ||
    reconsideration.steeringVersion < 0 ||
    typeof reconsideration.fingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(reconsideration.fingerprint)
  ) {
    return false;
  }
  const selection = normalizeRoleCapabilitySelectionProjection(
    reconsideration.selection,
  );
  return (
    selection !== undefined &&
    isReconsiderationCauseBoundToInvocationCount(
      reconsideration.cause,
      selection.invocations.length,
    ) &&
    createRoleCapabilitySelectionFingerprint({
      steeringVersion: reconsideration.steeringVersion,
      selection,
    }) === reconsideration.fingerprint
  );
}

function validateCapabilityExecutions(
  state: RoleCallState,
  policy: RoleCallPolicy,
  issues: RoleCallValidationIssue[],
): void {
  const executionIds = new Set(
    state.capabilityExecutions.map((execution) => execution.executionId),
  );
  if (executionIds.size !== state.capabilityExecutions.length) {
    issues.push(
      issue(
        "duplicate_role_capability_execution_id",
        "state.capabilityExecutions",
      ),
    );
  }

  const running = state.capabilityExecutions.filter(
    (execution) => execution.status === "running",
  );
  if (
    running.length > 1 &&
    (new Set(running.map((execution) => execution.callId)).size !== 1 ||
      new Set(running.map((execution) => execution.invocationAttempt)).size !==
        1 ||
      running.some((execution) => execution.declaredEffect !== "observation"))
  ) {
    issues.push(
      issue(
        "invalid_running_role_capability_batch",
        "state.capabilityExecutions",
      ),
    );
  }

  for (const execution of state.capabilityExecutions) {
    const call = findCall(state, execution.callId);
    if (
      !call ||
      !hasCapabilityAuthority(policy.authority, state, call) ||
      !isBoundedText(execution.executionId, 128) ||
      !Number.isInteger(execution.invocationAttempt) ||
      execution.invocationAttempt < 1 ||
      !isRoleCapabilityId(execution.capabilityId) ||
      !isRoleCapabilityDeclaredEffect(execution.declaredEffect) ||
      !isBoundedText(
        execution.intent,
        ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH,
      ) ||
      !isExactJsonObjectString(execution.controlsJson) ||
      !isValidExecutionActionFingerprint(execution) ||
      (execution.status !== "running" && execution.status !== "settled")
    ) {
      issues.push(
        issue(
          "invalid_role_capability_execution",
          `state.capabilityExecutions.${execution.executionId}`,
        ),
      );
      continue;
    }
    if (
      execution.status === "running" &&
      (state.phase !== "running" ||
        state.activeCallId !== call.callId ||
        call.status !== "waiting_for_capability" ||
        call.activationCount !== execution.invocationAttempt ||
        execution.outcome !== null ||
        execution.outcomeFingerprint !== null ||
        execution.observedEffect !== null ||
        execution.summary !== null ||
        execution.referenceData !== undefined ||
        execution.references !== undefined ||
        execution.exactResult !== undefined)
    ) {
      issues.push(
        issue(
          "invalid_running_role_capability_execution",
          `state.capabilityExecutions.${execution.executionId}`,
        ),
      );
    }
    if (
      execution.status === "settled" &&
      (call.activationCount <= execution.invocationAttempt ||
        !isBoundedText(execution.summary, policy.limits.maxResultChars) ||
        !isOptionalBoundedText(
          execution.referenceData,
          ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
        ) ||
        !isValidCapabilityResultReferences(execution.references) ||
        !isExactResultValidForCall(call, execution.exactResult) ||
        (execution.outcome !== "succeeded" && execution.outcome !== "failed") ||
        (execution.outcomeFingerprint !== null &&
          !isRoleOperationOutcomeFingerprintForOutcome(
            execution.outcomeFingerprint,
            execution.outcome,
          )) ||
        !isSettledObservedEffectCompatible({
          declaredEffect: execution.declaredEffect,
          outcome: execution.outcome,
          observedEffect: execution.observedEffect,
        }))
    ) {
      issues.push(
        issue(
          "invalid_settled_role_capability_execution",
          `state.capabilityExecutions.${execution.executionId}`,
        ),
      );
    }
  }

  for (const call of state.calls) {
    const ownedRunning = running.filter(
      (execution) => execution.callId === call.callId,
    );
    if (
      (call.status === "waiting_for_capability" && ownedRunning.length < 1) ||
      (call.status !== "waiting_for_capability" && ownedRunning.length !== 0)
    ) {
      issues.push(
        issue(
          "invalid_role_capability_call_ownership",
          `state.calls.${call.callId}`,
        ),
      );
    }
  }

  const invocationGroups = new Map<string, RoleCapabilityExecution[]>();
  for (const execution of state.capabilityExecutions) {
    const key = `${execution.callId}:${execution.invocationAttempt}`;
    const group = invocationGroups.get(key) ?? [];
    group.push(execution);
    invocationGroups.set(key, group);
  }
  for (const group of invocationGroups.values()) {
    if (
      group.length > 1 &&
      (group.some((execution) => execution.declaredEffect !== "observation") ||
        new Set(group.map((execution) => execution.status)).size !== 1)
    ) {
      issues.push(
        issue(
          "invalid_role_capability_batch_group",
          "state.capabilityExecutions",
        ),
      );
    }
  }
}

function isValidExecutionActionFingerprint(
  execution: RoleCapabilityExecution,
): boolean {
  return (
    execution.actionFingerprint === undefined ||
    isRoleOperationFingerprint(execution.actionFingerprint)
  );
}

function isValidRoleOperationSupervision(
  state: RoleCallState,
  policy: RoleCallPolicy,
): boolean {
  const interventions = state.operationSupervision.interventions;
  const allInterventionsWereIssuedForRequest = interventions.every(
    (intervention) =>
      isIssuedRoleOperationSupervisionInterventionForRequest({
        requestId: state.requestId,
        intervention,
      }),
  );
  if (!allInterventionsWereIssuedForRequest) return false;
  const settlements = projectOperationSupervisionSettlements(
    state.capabilityExecutions,
  );
  if (!isRoleOperationSupervisionSettlementHistoryValid(settlements)) {
    return false;
  }
  const replayed = replayRoleOperationSupervisionEvidence({
    settlements,
    interventions,
  });
  if (
    !replayed ||
    state.operationSupervision.entries.length !== replayed.entries.length
  ) {
    return false;
  }
  return (
    state.operationSupervision.entries.every((current, index) => {
      const replayedEntry = replayed.entries[index];
      return (
        replayedEntry !== undefined &&
        isSameRoleOperationSupervisionEntry(current, replayedEntry)
      );
    }) &&
    interventions.every((intervention) =>
      isValidOperationSupervisionIntervention(state, policy, intervention),
    )
  );
}

function projectOperationSupervisionSettlements(
  executions: readonly RoleCapabilityExecution[],
): readonly RoleOperationSupervisionSettlement[] {
  const settlements: RoleOperationSupervisionSettlement[] = [];
  for (const execution of executions) {
    if (
      execution.status !== "settled" ||
      execution.outcome === null ||
      execution.observedEffect === null
    ) {
      continue;
    }
    settlements.push({
      capabilityId: execution.capabilityId,
      ...(execution.actionFingerprint
        ? { actionFingerprint: execution.actionFingerprint }
        : {}),
      outcome: execution.outcome,
      ...(execution.outcomeFingerprint
        ? { outcomeFingerprint: execution.outcomeFingerprint }
        : {}),
      observedEffect: execution.observedEffect,
      originExecutionId: execution.executionId,
    });
  }
  return settlements;
}

function isSameRoleOperationSupervisionEntry(
  left: RoleOperationSupervisionEntry,
  right: RoleOperationSupervisionEntry,
): boolean {
  if (
    left.stage !== right.stage ||
    !isSameRoleOperationIdentity(left, right) ||
    left.priorOutcome !== right.priorOutcome ||
    left.outcomeFingerprint !== right.outcomeFingerprint ||
    left.originExecutionId !== right.originExecutionId ||
    left.matchingOutcomeCount !== right.matchingOutcomeCount
  ) {
    return false;
  }
  if (left.stage !== "intervened" || right.stage !== "intervened") {
    return true;
  }
  return (
    left.interventionCount === right.interventionCount &&
    left.interventionCallId === right.interventionCallId &&
    left.interventionInvocationAttempt === right.interventionInvocationAttempt
  );
}

function isValidOperationSupervisionIntervention(
  state: RoleCallState,
  policy: RoleCallPolicy,
  intervention: RoleOperationSupervisionInterventionRecord,
): boolean {
  const call = findCall(state, intervention.interventionCallId);
  const executionWasRecordedForIntervention = state.capabilityExecutions.some(
    (execution) =>
      execution.callId === intervention.interventionCallId &&
      execution.invocationAttempt ===
        intervention.interventionInvocationAttempt,
  );
  return (
    hasCapabilityAuthority(policy.authority, state, call) &&
    intervention.interventionInvocationAttempt < call.activationCount &&
    !executionWasRecordedForIntervention
  );
}

export function hasCapabilityAuthority(
  authority: ExecutionPolicyAuthoritySnapshot,
  state: RoleCallState,
  call: RoleCallFrame | undefined,
): call is RoleCallFrame {
  return hasRoleCallCapabilityAuthority(authority, state.rootCallId, call);
}

export function hasRoleCallCapabilityAuthority(
  authority: ExecutionPolicyAuthoritySnapshot,
  rootCallId: string | null,
  call: RoleCallFrame | undefined,
): call is RoleCallFrame {
  if (!call) return false;
  const principal =
    call.callId === rootCallId && call.parentCallId === null
      ? "root"
      : isRuntimeDelegateRoleId(call.roleId) && call.parentCallId !== null
        ? call.roleId
        : undefined;
  return (
    principal !== undefined &&
    authority.capabilityAuthorities.includes(principal)
  );
}

function isAuthorizedCallFrame(
  authority: ExecutionPolicyAuthoritySnapshot,
  rootCallId: string | null,
  call: RoleCallFrame,
): boolean {
  if (call.callId === rootCallId) {
    return call.parentCallId === null && call.roleId === RUNTIME_ROOT_ROLE_ID;
  }
  return (
    call.parentCallId !== null &&
    isRuntimeDelegateRoleId(call.roleId) &&
    authority.availableSubordinateContractIds.includes(call.roleId)
  );
}

function isExecutionPolicyAuthoritySnapshot(
  value: unknown,
): value is ExecutionPolicyAuthoritySnapshot {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        "id",
        "version",
        "definitionHash",
        "rootContractId",
        "availableSubordinateContractIds",
        "capabilityAuthorities",
      ],
      ["terminalTextMode"],
    ) ||
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(value.id) ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.definitionHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.definitionHash) ||
    !isExecutionContractId(value.rootContractId) ||
    !Array.isArray(value.availableSubordinateContractIds) ||
    !Array.isArray(value.capabilityAuthorities) ||
    (value.terminalTextMode !== undefined &&
      value.terminalTextMode !== "normalized" &&
      value.terminalTextMode !== "exact")
  ) {
    return false;
  }
  const subordinateIds = value.availableSubordinateContractIds;
  const capabilityAuthorities = value.capabilityAuthorities;
  return (
    new Set(subordinateIds).size === subordinateIds.length &&
    subordinateIds.every(isRuntimeDelegateRoleId) &&
    new Set(capabilityAuthorities).size === capabilityAuthorities.length &&
    capabilityAuthorities.every(
      (principal) => principal === "root" || isRuntimeDelegateRoleId(principal),
    ) &&
    capabilityAuthorities.every(
      (principal) => principal === "root" || subordinateIds.includes(principal),
    )
  );
}

function isExecutionContractId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z][a-z0-9._-]*$/.test(value)
  );
}

function isCanonicalRoleCallWorkingDirectory(
  state: RoleCallState,
  call: RoleCallFrame,
  authority: ExecutionPolicyAuthoritySnapshot,
): boolean {
  if (call.callId === state.rootCallId && call.parentCallId === null) {
    return (
      hasRoleCallCapabilityAuthority(authority, state.rootCallId, call) &&
      normalizeEstablishedRoleCallWorkingDirectory(call.workingDirectory) ===
        call.workingDirectory
    );
  }
  return (
    isRoleCallWorkingDirectoryRoleId(call.roleId) &&
    normalizeRoleCallWorkingDirectory(call.workingDirectory) ===
      call.workingDirectory
  );
}
