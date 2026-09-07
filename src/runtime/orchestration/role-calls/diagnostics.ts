import { traceDebug } from "../../observability/debug-logger.js";
import type {
  RoleCallCommitEffect,
  RoleCallLedgerHead,
  RoleCallLedgerRejectionCode,
  RoleCallValidationIssue,
} from "./contracts.js";
import { resolveRoleActivationBudget } from "./activation-budget.js";
import { isSuccessfulObservedMutation } from "./operation-supervision.js";
import { traceMemoryRecallCommit } from "./memory-recall-diagnostics.js";

const ROLE_CALL_LOG_SCOPE = "runtime.role_calls";

export type RoleCallRejectedCommandDiagnostic = Readonly<{
  attemptedCallId?: string;
  attemptedDependencyResultRefs?: readonly string[];
  attemptedExecutionId?: string;
  attemptedInvocationAttempt?: number;
  attemptedSteeringVersion?: number;
  attemptedCapabilityId?: string;
  attemptedActionFingerprint?: string;
  attemptedSelectionReceiptFingerprint?: string;
  attemptedSelectionSupervisionFingerprint?: string;
  attemptedPlanMode?: "declare" | "select" | "extend";
  attemptedPlanItemIds?: readonly string[];
  attemptedPlanItemCount?: number;
  attemptedPlanSummaryLength?: number;
  attemptedSelectedItemIndexes?: readonly number[];
  attemptedWorkerCapabilityCatalogGroupIds?: readonly string[];
  attemptedCapabilityScopeMode?: "open" | "extend";
  attemptedWorkingDirectoryIncluded?: boolean;
  attemptedWorkingDirectoryLength?: number;
  attemptedDeclaredEffect?: "observation" | "mutation" | "mixed";
  attemptedOutcome?: "succeeded" | "failed";
  attemptedObservedEffect?:
    | "none"
    | "observation"
    | "mutation"
    | "indeterminate";
}>;

export function traceRoleCallCommit(params: {
  previousHead: RoleCallLedgerHead;
  head: RoleCallLedgerHead;
  effect: RoleCallCommitEffect;
}): void {
  const state = params.head.state;
  const activationBudget = resolveRoleActivationBudget(
    state,
    params.head.policy,
  );
  const common = {
    requestId: state.requestId,
    previousRevision: params.previousHead.revision,
    revision: params.head.revision,
    phase: state.phase,
    rootCallId: state.rootCallId,
    activeCallId: state.activeCallId,
    callCount: state.calls.length,
    planCount: state.plans.length,
    capabilityExecutionCount: state.capabilityExecutions.length,
    maxCalls: params.head.policy.limits.maxCalls,
    maxCapabilityExecutions: params.head.policy.limits.maxCapabilityExecutions,
    maxDepth: params.head.policy.limits.maxDepth,
    ...activationBudget,
  };
  traceDebug(ROLE_CALL_LOG_SCOPE, "transition.committed", {
    ...common,
    effectType: params.effect.type,
  });
  traceCapabilitySelectionSupervisionReset(params, common);
  if (traceMemoryRecallCommit(params, common)) return;

  switch (params.effect.type) {
    case "root_created": {
      traceDebug(ROLE_CALL_LOG_SCOPE, "root.created", {
        ...common,
        callId: params.effect.callId,
        parentCallId: null,
        roleId: "supervisor",
        depth: 0,
        activationCount: 1,
      });
      return;
    }
    case "root_response_committed": {
      traceDebug(ROLE_CALL_LOG_SCOPE, "root.response_committed", {
        ...common,
        callId: params.effect.callId,
        responseLength: state.rootResponse?.length ?? 0,
      });
      return;
    }
    case "child_opened": {
      const effect = params.effect;
      const child = findCall(params.head, effect.childCallId);
      const plan = effect.planItemIds
        ? state.plans.find(
            (candidate) =>
              candidate.definition.plannerCallId === effect.callerCallId,
          )
        : undefined;
      traceDebug(ROLE_CALL_LOG_SCOPE, "caller.suspended", {
        ...common,
        callId: effect.callerCallId,
        childCallId: effect.childCallId,
      });
      traceDebug(ROLE_CALL_LOG_SCOPE, "child.opened", {
        ...common,
        callId: effect.childCallId,
        parentCallId: effect.callerCallId,
        roleId: child?.roleId,
        depth: child?.depth,
        activationCount: child?.activationCount,
        objectiveLength: child?.objective?.length ?? 0,
        dependencyResultCount: child?.dependencyResultRefs.length ?? 0,
        dependencyResultRefs: child?.dependencyResultRefs ?? [],
        workerCapabilityCatalogGroupIds:
          child?.workerCapabilityScope?.catalogGroupIds,
        workerCapabilityCatalogGroupCount:
          child?.workerCapabilityScope?.catalogGroupIds.length ?? 0,
        workingDirectoryIncluded: child?.workingDirectory !== undefined,
        workingDirectoryLength: child?.workingDirectory?.length ?? 0,
        planItemIds: effect.planItemIds,
        planItemBindingCount: effect.planItemIds?.length ?? 0,
        planId: plan?.definition.planId,
        planItemCount: plan?.definition.items.length,
        planSummaryLength: plan?.definition.summary.length,
      });
      return;
    }
    case "child_returned": {
      const effect = params.effect;
      const child = findCall(params.head, effect.childCallId);
      const caller = findCall(params.head, effect.callerCallId);
      const result = state.results.find(
        (entry) => entry.resultRef === effect.resultRef,
      );
      traceDebug(ROLE_CALL_LOG_SCOPE, "child.returned", {
        ...common,
        callId: effect.childCallId,
        parentCallId: effect.callerCallId,
        roleId: child?.roleId,
        depth: child?.depth,
        resultRef: effect.resultRef,
        childOutcome: result?.outcome,
        summaryLength: result?.summary.length ?? 0,
        planItemIds: effect.planItemIds,
        settledPlanItemCount: effect.planItemIds?.length ?? 0,
      });
      traceDebug(ROLE_CALL_LOG_SCOPE, "caller.resumed", {
        ...common,
        callId: effect.callerCallId,
        childCallId: effect.childCallId,
        resultRef: effect.resultRef,
        activationCount: caller?.activationCount,
      });
      return;
    }
    case "capability_execution_begun": {
      const execution = findCapabilityExecution(
        params.head,
        params.effect.executionId,
      );
      traceDebug(ROLE_CALL_LOG_SCOPE, "capability.execution_begun", {
        ...common,
        callId: params.effect.callId,
        executionId: params.effect.executionId,
        invocationAttempt: execution?.invocationAttempt,
        capabilityId: execution?.capabilityId,
        declaredEffect: execution?.declaredEffect,
        actionFingerprint: execution?.actionFingerprint,
      });
      traceDebug(ROLE_CALL_LOG_SCOPE, "caller.suspended", {
        ...common,
        callId: params.effect.callId,
        capabilityExecutionId: params.effect.executionId,
      });
      return;
    }
    case "operation_supervision_intervened": {
      const call = findCall(params.head, params.effect.callId);
      traceDebug(ROLE_CALL_LOG_SCOPE, "operation.supervision_intervened", {
        ...common,
        callId: params.effect.callId,
        invocationAttempt: params.effect.invocationAttempt,
        capabilityId: params.effect.capabilityId,
        actionFingerprint: params.effect.actionFingerprint,
        priorOutcome: params.effect.priorOutcome,
        outcomeFingerprint: params.effect.outcomeFingerprint,
        originExecutionId: params.effect.originExecutionId,
        matchingOutcomeCount: params.effect.matchingOutcomeCount,
        interventionCount: params.effect.interventionCount,
        activationCount: call?.activationCount,
      });
      return;
    }
    case "capability_execution_settled": {
      const execution = findCapabilityExecution(
        params.head,
        params.effect.executionId,
      );
      const call = findCall(params.head, params.effect.callId);
      traceDebug(ROLE_CALL_LOG_SCOPE, "capability.execution_settled", {
        ...common,
        callId: params.effect.callId,
        executionId: params.effect.executionId,
        invocationAttempt: execution?.invocationAttempt,
        capabilityId: execution?.capabilityId,
        declaredEffect: execution?.declaredEffect,
        actionFingerprint: execution?.actionFingerprint,
        outcome: execution?.outcome,
        outcomeFingerprint: execution?.outcomeFingerprint,
        observedEffect: execution?.observedEffect,
        summaryLength: execution?.summary?.length ?? 0,
      });
      if (
        execution &&
        isSuccessfulObservedMutation(execution) &&
        didClearOperationSupervision(params)
      ) {
        traceDebug(ROLE_CALL_LOG_SCOPE, "operation.supervision_reset", {
          ...common,
          callId: params.effect.callId,
          executionId: params.effect.executionId,
          invocationAttempt: execution.invocationAttempt,
          capabilityId: execution.capabilityId,
          actionFingerprint: execution.actionFingerprint,
          cause: "successful_observed_mutation",
          clearedEntryCount:
            params.previousHead.state.operationSupervision.entries.length,
          clearedInterventionCount:
            params.previousHead.state.operationSupervision.interventions.length,
          activationCount: call?.activationCount,
        });
      }
      traceDebug(ROLE_CALL_LOG_SCOPE, "caller.resumed", {
        ...common,
        callId: params.effect.callId,
        capabilityExecutionId: params.effect.executionId,
        activationCount: call?.activationCount,
      });
      return;
    }
    case "capability_batch_begun": {
      const executions = params.effect.executionIds.map((executionId) =>
        findCapabilityExecution(params.head, executionId),
      );
      traceDebug(ROLE_CALL_LOG_SCOPE, "capability.batch_begun", {
        ...common,
        callId: params.effect.callId,
        executionIds: params.effect.executionIds,
        batchSize: params.effect.executionIds.length,
        invocationAttempt: executions[0]?.invocationAttempt,
        capabilityIds: executions.map((execution) => execution?.capabilityId),
        declaredEffects: executions.map(
          (execution) => execution?.declaredEffect,
        ),
      });
      traceDebug(ROLE_CALL_LOG_SCOPE, "caller.suspended", {
        ...common,
        callId: params.effect.callId,
        capabilityExecutionIds: params.effect.executionIds,
      });
      return;
    }
    case "capability_batch_settled": {
      const executions = params.effect.executionIds.map((executionId) =>
        findCapabilityExecution(params.head, executionId),
      );
      const call = findCall(params.head, params.effect.callId);
      traceDebug(ROLE_CALL_LOG_SCOPE, "capability.batch_settled", {
        ...common,
        callId: params.effect.callId,
        executionIds: params.effect.executionIds,
        batchSize: params.effect.executionIds.length,
        invocationAttempt: executions[0]?.invocationAttempt,
        capabilityIds: executions.map((execution) => execution?.capabilityId),
        outcomes: executions.map((execution) => execution?.outcome),
        outcomeFingerprints: executions.map(
          (execution) => execution?.outcomeFingerprint,
        ),
        observedEffects: executions.map(
          (execution) => execution?.observedEffect,
        ),
        summaryLength: executions.reduce(
          (total, execution) => total + (execution?.summary?.length ?? 0),
          0,
        ),
      });
      traceDebug(ROLE_CALL_LOG_SCOPE, "caller.resumed", {
        ...common,
        callId: params.effect.callId,
        capabilityExecutionIds: params.effect.executionIds,
        activationCount: call?.activationCount,
      });
      return;
    }
    case "capability_scope_updated": {
      const call = findCall(params.head, params.effect.callId);
      traceDebug(ROLE_CALL_LOG_SCOPE, "capability.scope_updated", {
        ...common,
        callId: params.effect.callId,
        scopeMode: params.effect.mode,
        workerCapabilityCatalogGroupIds: params.effect.catalogGroupIds,
        workerCapabilityCatalogGroupCount: params.effect.catalogGroupIds.length,
        activationCount: call?.activationCount,
      });
      return;
    }
    case "working_directory_established": {
      const call = findCall(params.head, params.effect.callId);
      traceDebug(ROLE_CALL_LOG_SCOPE, "working_directory.established", {
        ...common,
        callId: params.effect.callId,
        workingDirectoryIncluded: call?.workingDirectory !== undefined,
        workingDirectoryLength: call?.workingDirectory?.length ?? 0,
        activationCount: call?.activationCount,
      });
      return;
    }
    case "capability_selection_reconsidered": {
      const call = findCall(params.head, params.effect.callId);
      const reconsideration = call?.lastCapabilitySelectionReconsideration;
      const cause = reconsideration?.cause;
      traceDebug(ROLE_CALL_LOG_SCOPE, "capability.selection_reconsidered", {
        ...common,
        callId: params.effect.callId,
        invocationAttempt: params.effect.invocationAttempt,
        steeringVersion: reconsideration?.steeringVersion,
        selectionFingerprint: params.effect.fingerprint,
        selectionReceiptFingerprint: params.effect.fingerprint,
        selectionSupervisionFingerprint: params.effect.supervisionFingerprint,
        selectionSupervisionStage: params.effect.supervisionStage,
        selectionSupervisionTrigger: params.effect.supervisionTrigger,
        matchingSelectionCount: params.effect.matchingSelectionCount,
        totalReconsiderationCount: params.effect.totalReconsiderationCount,
        activationCount: call?.activationCount,
        causeKind: cause?.kind,
        ...(cause?.kind === "refinement_declined"
          ? { declinedInvocationCount: cause.entries.length }
          : {}),
        ...(cause?.kind === "refinement_invalid_output"
          ? {
              validationStage: cause.validationStage,
              issueCount: cause.issues.length,
              repairAttempts: cause.repairAttempts,
              repeatedInvalidOutput: cause.repeatedInvalidOutput,
            }
          : {}),
      });
      return;
    }
  }
}

function didClearOperationSupervision(params: {
  previousHead: RoleCallLedgerHead;
  head: RoleCallLedgerHead;
}): boolean {
  const previous = params.previousHead.state.operationSupervision;
  const current = params.head.state.operationSupervision;
  const hadSupervisionEvidence =
    previous.entries.length > 0 || previous.interventions.length > 0;
  return (
    hadSupervisionEvidence &&
    current.entries.length === 0 &&
    current.interventions.length === 0
  );
}

export function traceRoleCallCommitFault(params: {
  previousHead: RoleCallLedgerHead;
  head: RoleCallLedgerHead;
  effect: RoleCallCommitEffect;
  code: "after_commit_fault" | "transaction_callback_fault";
}): void {
  traceDebug(ROLE_CALL_LOG_SCOPE, "transition.committed_with_fault", {
    requestId: params.head.state.requestId,
    previousRevision: params.previousHead.revision,
    revision: params.head.revision,
    phase: params.head.state.phase,
    rootCallId: params.head.state.rootCallId,
    activeCallId: params.head.state.activeCallId,
    effectType: params.effect.type,
    faultCode: params.code,
    callCount: params.head.state.calls.length,
    planCount: params.head.state.plans.length,
    capabilityExecutionCount: params.head.state.capabilityExecutions.length,
    maxCalls: params.head.policy.limits.maxCalls,
    maxCapabilityExecutions: params.head.policy.limits.maxCapabilityExecutions,
    maxDepth: params.head.policy.limits.maxDepth,
  });
}

export function traceRoleCallRejection(params: {
  head: RoleCallLedgerHead;
  commandType: string;
  code: RoleCallLedgerRejectionCode;
  command: RoleCallRejectedCommandDiagnostic;
  issues?: readonly RoleCallValidationIssue[];
}): void {
  const activationBudget = resolveRoleActivationBudget(
    params.head.state,
    params.head.policy,
  );
  const execution = params.command.attemptedExecutionId
    ? findCapabilityExecution(params.head, params.command.attemptedExecutionId)
    : undefined;
  const selectionSupervision =
    projectRejectedCapabilitySelectionSupervision(params);
  const rejectionDiagnostic = {
    requestId: params.head.state.requestId,
    revision: params.head.revision,
    phase: params.head.state.phase,
    rootCallId: params.head.state.rootCallId,
    activeCallId: params.head.state.activeCallId,
    commandType: params.commandType,
    rejectionCode: params.code,
    ...activationBudget,
    ...params.command,
    ...selectionSupervision,
    ...(execution
      ? {
          capabilityId: execution.capabilityId,
          declaredEffect: execution.declaredEffect,
          invocationAttempt: execution.invocationAttempt,
        }
      : {}),
    issueCount: params.issues?.length ?? 0,
    issues: params.issues?.map(({ code, path }) => ({ code, path })) ?? [],
    callCount: params.head.state.calls.length,
    planCount: params.head.state.plans.length,
    capabilityExecutionCount: params.head.state.capabilityExecutions.length,
    maxCalls: params.head.policy.limits.maxCalls,
    maxCapabilityExecutions: params.head.policy.limits.maxCapabilityExecutions,
    maxDepth: params.head.policy.limits.maxDepth,
  };
  traceDebug(ROLE_CALL_LOG_SCOPE, "transition.rejected", rejectionDiagnostic);
  if (params.code === "capability_selection_supervision_limit_exceeded") {
    traceDebug(
      ROLE_CALL_LOG_SCOPE,
      "capability_selection.supervision_terminal",
      rejectionDiagnostic,
    );
  }
}

function traceCapabilitySelectionSupervisionReset(
  params: {
    previousHead: RoleCallLedgerHead;
    head: RoleCallLedgerHead;
    effect: RoleCallCommitEffect;
  },
  common: Readonly<Record<string, unknown>>,
): void {
  const previous = params.previousHead.state.capabilitySelectionSupervision;
  const current = params.head.state.capabilitySelectionSupervision;
  if (previous.records.length === 0) return;
  const cause = resolveCapabilitySelectionSupervisionResetCause(params);
  if (!cause) return;
  traceDebug(ROLE_CALL_LOG_SCOPE, "capability_selection.supervision_reset", {
    ...common,
    callId: previous.epoch?.callId,
    steeringVersion: previous.epoch?.steeringVersion,
    resetReason: cause,
    clearedRecordCount: previous.records.length,
    clearedIdentityCount: new Set(
      previous.records.map((record) => record.supervisionFingerprint),
    ).size,
    nextSteeringVersion: current.epoch?.steeringVersion,
  });
}

function resolveCapabilitySelectionSupervisionResetCause(params: {
  previousHead: RoleCallLedgerHead;
  head: RoleCallLedgerHead;
  effect: RoleCallCommitEffect;
}): string | undefined {
  const previous = params.previousHead.state.capabilitySelectionSupervision;
  const current = params.head.state.capabilitySelectionSupervision;
  if (
    params.effect.type === "capability_selection_reconsidered" &&
    previous.epoch?.steeringVersion !== current.epoch?.steeringVersion
  ) {
    return "steering_version_changed";
  }
  if (current.records.length > 0) return undefined;
  switch (params.effect.type) {
    case "root_response_committed":
      return "root_completed";
    case "child_opened":
      return "child_opened";
    case "child_returned":
      return "child_returned";
    case "capability_execution_begun":
    case "capability_batch_begun":
    case "operation_supervision_intervened":
      return "materialized_capability_attempt";
    case "capability_scope_updated":
      return "capability_scope_updated";
    case "working_directory_established":
      return "working_directory_established";
    default:
      return undefined;
  }
}

function projectRejectedCapabilitySelectionSupervision(params: {
  head: RoleCallLedgerHead;
  code: RoleCallLedgerRejectionCode;
  command: RoleCallRejectedCommandDiagnostic;
  issues?: readonly RoleCallValidationIssue[];
}): Readonly<Record<string, unknown>> {
  if (
    params.code !== "capability_selection_supervision_limit_exceeded" ||
    !params.command.attemptedSelectionSupervisionFingerprint
  ) {
    return Object.freeze({});
  }
  const state = params.head.state.capabilitySelectionSupervision;
  const sameEpoch =
    state.epoch?.callId === params.command.attemptedCallId &&
    state.epoch?.steeringVersion === params.command.attemptedSteeringVersion;
  const matchingSelectionCount =
    (sameEpoch
      ? state.records.filter(
          (record) =>
            record.supervisionFingerprint ===
            params.command.attemptedSelectionSupervisionFingerprint,
        ).length
      : 0) + 1;
  const totalReconsiderationCount = (sameEpoch ? state.records.length : 0) + 1;
  const issueCode = params.issues?.[0]?.code;
  const trigger =
    issueCode === "capability_selection_repeat_limit_exceeded"
      ? "repeat_identity"
      : issueCode === "capability_selection_total_limit_exceeded"
        ? "total_budget"
        : "repeat_and_total";
  return Object.freeze({
    selectionSupervisionStage: "terminal",
    selectionSupervisionTrigger: trigger,
    matchingSelectionCount,
    totalReconsiderationCount,
  });
}

function findCall(
  head: RoleCallLedgerHead,
  callId: string,
): RoleCallLedgerHead["state"]["calls"][number] | undefined {
  return head.state.calls.find((call) => call.callId === callId);
}

function findCapabilityExecution(
  head: RoleCallLedgerHead,
  executionId: string,
): RoleCallLedgerHead["state"]["capabilityExecutions"][number] | undefined {
  return head.state.capabilityExecutions.find(
    (execution) => execution.executionId === executionId,
  );
}
