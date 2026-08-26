import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RoleChildReturnContext } from "../../orchestration/role-calls/index.js";
import {
  PLANNER_ROLE_ID,
  type PlannerDecision,
  type PlannerDecisionDiagnosticContext,
  type PlannerDecisionPlanContext,
  type PlannerDecisionSelectionKind,
  type PlannerDecisionValidationIssue,
} from "./contracts.js";

const PLANNER_LOG_SCOPE = "runtime.planner";

export function tracePlannerContextProjected(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  objectiveLength: number;
  workingDirectoryInherited: boolean;
  workingDirectoryLength: number;
  availableChildRoleIds: readonly string[];
  workerCapabilityCatalogGroupIds: readonly string[];
  workerCapabilityCatalogMemberCount: number;
  referenceMessageCount: number;
  continuationMessageCount: number;
  completedChildResultCount: number;
  completedChildSummaryLength: number;
  dependencyResultRefs: readonly string[];
  dependencyResultSummaryLength: number;
  sourceToolResultCount: number;
  projectedToolResultCount: number;
  supersededToolResultCount: number;
  retainedFailedToolResultCount: number;
  retainedUntargetedToolResultCount: number;
  allowedActions: readonly PlannerDecisionSelectionKind[];
  configuredInstructionBlockCount: number;
  configuredInstructionCharacterCount: number;
  configuredInstructionRefs: readonly string[];
  configuredInstructionContentHashes: readonly string[];
  planContext?: PlannerDecisionPlanContext;
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "context.projected", {
    ...baseFields(params.diagnostic),
    objectiveLength: params.objectiveLength,
    workingDirectoryInherited: params.workingDirectoryInherited,
    workingDirectoryIncluded: params.workingDirectoryInherited,
    workingDirectoryLength: params.workingDirectoryLength,
    messageCount: params.context.messages.length,
    messageCharacterCount: params.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    historyMessageCount: 0,
    attachmentCount: 0,
    referenceMessageCount: params.referenceMessageCount,
    continuationMessageCount: params.continuationMessageCount,
    projectContextIncluded: false,
    plannedWorkContextIncluded: false,
    capabilityContextIncluded:
      params.workerCapabilityCatalogGroupIds.length > 0,
    workerCapabilityCatalogGroupCount:
      params.workerCapabilityCatalogGroupIds.length,
    workerCapabilityCatalogGroupIds: params.workerCapabilityCatalogGroupIds,
    workerCapabilityCatalogMemberCount:
      params.workerCapabilityCatalogMemberCount,
    availableChildRoleCount: params.availableChildRoleIds.length,
    availableChildRoleIds: params.availableChildRoleIds,
    completedChildResultCount: params.completedChildResultCount,
    completedChildSummaryLength: params.completedChildSummaryLength,
    roleDependencyContextIncluded: params.dependencyResultRefs.length > 0,
    dependencyResultCount: params.dependencyResultRefs.length,
    dependencyResultRefs: params.dependencyResultRefs,
    dependencyResultSummaryLength: params.dependencyResultSummaryLength,
    sourceToolResultCount: params.sourceToolResultCount,
    projectedToolResultCount: params.projectedToolResultCount,
    supersededToolResultCount: params.supersededToolResultCount,
    retainedFailedToolResultCount: params.retainedFailedToolResultCount,
    retainedUntargetedToolResultCount: params.retainedUntargetedToolResultCount,
    ...planContextFields(params.planContext),
    schemaCharacterCount: JSON.stringify(params.format.schema).length,
    configuredInstructionBlockCount: params.configuredInstructionBlockCount,
    configuredInstructionCharacterCount:
      params.configuredInstructionCharacterCount,
    configuredInstructionRefs: params.configuredInstructionRefs,
    configuredInstructionContentHashes:
      params.configuredInstructionContentHashes,
    estimatedInputTokens: params.context.budget.estimatedInputTokens,
    availableInputTokens: params.context.budget.availableInputTokens,
    allowedActions: params.allowedActions,
  });
}

export function tracePlannerChildResultsProjected(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  resume: RoleChildReturnContext;
  continuationMessageCount: number;
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "child_results.projected", {
    ...baseFields(params.diagnostic),
    returnedChildCallId: params.resume.returnedChildCallId,
    returnedResultRef: params.resume.returnedResultRef,
    completedChildResultCount: params.resume.completedChildren.length,
    completedChildRoles: params.resume.completedChildren.map(
      (child) => child.roleId,
    ),
    completedChildOutcomeCounts: params.resume.completedChildren.reduce(
      (counts, child) => ({
        ...counts,
        [child.outcome]: counts[child.outcome] + 1,
      }),
      { completed: 0, failed: 0 },
    ),
    completedChildSummaryLength: params.resume.completedChildren.reduce(
      (total, child) => total + child.summary.length,
      0,
    ),
    continuationMessageCount: params.continuationMessageCount,
  });
}

export function tracePlannerEnvelopeAccepted(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  outputLength: number;
  keyCount: number;
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "output.envelope.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    rootType: "object",
    keyCount: params.keyCount,
  });
}

export function tracePlannerEnvelopeRejected(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  outputLength: number;
  issues: readonly PlannerDecisionValidationIssue[];
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "output.envelope.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function tracePlannerDecisionAccepted(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  decision: PlannerDecision;
  workingDirectorySource?: "model" | "inherited";
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "decision.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    selectedAction: decisionSelectionKind(params.decision),
    ...decisionFields(params.decision),
    ...(params.workingDirectorySource
      ? { workingDirectorySource: params.workingDirectorySource }
      : {}),
  });
}

export function tracePlannerDecisionRejected(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  issues: readonly PlannerDecisionValidationIssue[];
  selectedAction?: PlannerDecisionSelectionKind;
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "decision.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    ...(params.selectedAction ? { selectedAction: params.selectedAction } : {}),
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function tracePlannerModelStarted(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  messageCount: number;
  messageCharacterCount: number;
  allowedActions: readonly PlannerDecisionSelectionKind[];
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "model.started", {
    ...baseFields(params.diagnostic),
    messageCount: params.messageCount,
    messageCharacterCount: params.messageCharacterCount,
    allowedActions: params.allowedActions,
  });
}

export function tracePlannerModelCompleted(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  decision: PlannerDecision;
  durationMs: number;
  workingDirectorySource?: "model" | "inherited";
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "model.completed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    selectedAction: decisionSelectionKind(params.decision),
    ...decisionFields(params.decision),
    ...(params.workingDirectorySource
      ? { workingDirectorySource: params.workingDirectorySource }
      : {}),
  });
}

export function tracePlannerModelFailed(params: {
  diagnostic: PlannerDecisionDiagnosticContext;
  durationMs: number;
  errorType: string;
  invalidStructuredOutput: boolean;
}): void {
  traceDebug(PLANNER_LOG_SCOPE, "model.failed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    errorType: params.errorType,
    invalidStructuredOutput: params.invalidStructuredOutput,
  });
}

function decisionFields(decision: PlannerDecision): Record<string, unknown> {
  if (decision.action === "return_result") {
    return {
      resultLength: decision.result.length,
      mappedOutcome: "completed",
    };
  }
  if (decision.action === "return_failure") {
    return {
      resultLength: decision.reason.length,
      mappedOutcome: "failed",
    };
  }
  return {
    childRoleId: decision.roleId,
    childObjectiveLength: decision.objective.length,
    workingDirectoryIncluded: decision.roleId === "worker",
    ...(decision.roleId === "worker"
      ? { workingDirectoryLength: decision.workingDirectory.length }
      : {}),
    ...(decision.roleId === "worker" && decision.workerCapabilityScope
      ? {
          workerCapabilityScopeGroupCount:
            decision.workerCapabilityScope.catalogGroupIds.length,
          workerCapabilityScopeGroupIds:
            decision.workerCapabilityScope.catalogGroupIds,
        }
      : {}),
    ...(decision.plannerPlan?.mode === "declare"
      ? {
          planBindingMode: "declare",
          plannedItemCount: decision.plannerPlan.plan.items.length,
          selectedPlanItemIndexes: decision.plannerPlan.selectedItemIndexes,
          selectedPlanItemCount:
            decision.plannerPlan.selectedItemIndexes.length,
          planSummaryLength: decision.plannerPlan.plan.summary.length,
          plannedItemTitleLengths: decision.plannerPlan.plan.items.map(
            (item) => item.title.length,
          ),
          plannedItemObjectiveLengths: decision.plannerPlan.plan.items.map(
            (item) => item.objective.length,
          ),
        }
      : decision.plannerPlan?.mode === "extend"
        ? {
            planBindingMode: "extend",
            plannedItemCount: decision.plannerPlan.extension.items.length,
            selectedPlanItemIndexes: decision.plannerPlan.selectedItemIndexes,
            selectedPlanItemCount:
              decision.plannerPlan.selectedItemIndexes.length,
            plannedItemTitleLengths: decision.plannerPlan.extension.items.map(
              (item) => item.title.length,
            ),
            plannedItemObjectiveLengths:
              decision.plannerPlan.extension.items.map(
                (item) => item.objective.length,
              ),
          }
        : decision.plannerPlan?.mode === "select"
          ? {
              planBindingMode: "select",
              selectedPlanItemIds: decision.plannerPlan.itemIds,
              selectedPlanItemCount: decision.plannerPlan.itemIds.length,
            }
          : { planBindingMode: "none" }),
    mappedOutcome: "child_role_requested",
  };
}

function decisionSelectionKind(
  decision: PlannerDecision,
): PlannerDecisionSelectionKind {
  return decision.action;
}

function planContextFields(
  planContext: PlannerDecisionPlanContext | undefined,
): Record<string, unknown> {
  if (!planContext) return { planContextMode: "none" };
  if (planContext.mode === "declare") {
    return {
      planContextMode: "declare",
      planMaxItemCount: planContext.maxItems,
    };
  }
  if (planContext.mode === "extend") {
    return {
      planContextMode: "extend",
      planId: planContext.planId,
      existingPlanItemCount: planContext.existingItemCount,
      planMaxItemCount: planContext.maxItems,
      planSummaryLength: planContext.summary.length,
    };
  }
  return {
    planContextMode: "select",
    planId: planContext.planId,
    childInvocationAvailable: planContext.childInvocationAvailable,
    pendingPlanItemCount: planContext.pendingItems.length,
    pendingPlanItemIds: planContext.pendingItems.map((item) => item.itemId),
    planSummaryLength: planContext.summary.length,
    pendingPlanItemTitleLengths: planContext.pendingItems.map(
      (item) => item.title.length,
    ),
    pendingPlanItemObjectiveLengths: planContext.pendingItems.map(
      (item) => item.objective.length,
    ),
  };
}

function baseFields(
  diagnostic: PlannerDecisionDiagnosticContext,
): Record<string, unknown> {
  return {
    requestId: diagnostic.requestId,
    role: PLANNER_ROLE_ID,
    modelStep: diagnostic.modelStep,
    callId: diagnostic.callId,
    parentCallId: diagnostic.parentCallId,
    depth: diagnostic.depth,
    invocationAttempt: diagnostic.invocationAttempt,
  };
}

function boundedIssues(
  issues: readonly PlannerDecisionValidationIssue[],
): readonly Readonly<{ code: string; path: string }>[] {
  return issues.map(({ code, path }) => ({ code, path }));
}
