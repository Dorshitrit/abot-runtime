import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import type { CapabilityBriefProjection } from "../../context/capability-brief.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RoleChildReturnContext } from "../../orchestration/role-calls/index.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import {
  SUPERVISOR_DECISION_ACTIONS,
  SUPERVISOR_ROLE_ID,
  type SupervisorDecision,
  type SupervisorDecisionDiagnosticContext,
  type SupervisorDecisionValidationIssue,
  type SupervisorDelegateRoleId,
  type SupervisorRoutingDecision,
  type SupervisorWorkingDirectoryRoutingDecision,
  type SupervisorWorkerCapabilityAffordance,
} from "./contracts.js";

const SUPERVISOR_LOG_SCOPE = "runtime.supervisor";

export function traceSupervisorContextProjected(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  historyMessageCount: number;
  attachmentCount: number;
  referenceMessageCount: number;
  continuationMessageCount: number;
  completedChildResultCount: number;
  completedChildSummaryLength: number;
  allowedRoleIds: readonly SupervisorDelegateRoleId[];
  workerCapabilityAffordances: readonly SupervisorWorkerCapabilityAffordance[];
  availableWorkerCapabilityCatalog: readonly WorkerCapabilityCatalogGroup[];
  capabilityBrief: CapabilityBriefProjection;
  configuredInstructionBlockCount: number;
  configuredInstructionCharacterCount: number;
  configuredInstructionRefs: readonly string[];
  configuredInstructionContentHashes: readonly string[];
}): void {
  const workerCapabilityEffectCounts =
    params.workerCapabilityAffordances.reduce(
      (counts, affordance) => ({
        ...counts,
        [affordance.effect]: counts[affordance.effect] + 1,
      }),
      { observation: 0, mutation: 0, mixed: 0 },
    );
  traceDebug(SUPERVISOR_LOG_SCOPE, "context.projected", {
    ...baseFields(params.diagnostic),
    historyMessageCount: params.historyMessageCount,
    selectedHistoryMessageCount:
      params.context.selectedHistoryMessageIds.length,
    omittedHistoryMessageCount: params.context.omittedHistoryMessageIds.length,
    messageCount: params.context.messages.length,
    messageCharacterCount: params.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    attachmentCount: params.attachmentCount,
    referenceMessageCount: params.referenceMessageCount,
    continuationMessageCount: params.continuationMessageCount,
    completedChildResultCount: params.completedChildResultCount,
    completedChildSummaryLength: params.completedChildSummaryLength,
    projectContextIncluded: false,
    plannedWorkContextIncluded: false,
    capabilityContextIncluded: false,
    delegationContextPolicy: "explicit_role_context_exact_dependency_v1",
    workerCapabilityCatalogContextIncluded:
      params.capabilityBrief.level !== "none",
    capabilityBriefLevel: params.capabilityBrief.level,
    capabilityBriefEstimatedTokens: params.capabilityBrief.estimatedTokens,
    capabilityBriefBudgetTokens: params.capabilityBrief.budgetTokens,
    capabilityBriefReason: params.capabilityBrief.reason,
    availableWorkerCapabilityCatalogGroupCount:
      params.availableWorkerCapabilityCatalog.length,
    availableWorkerCapabilityCatalogGroupIds:
      params.availableWorkerCapabilityCatalog.map((group) => group.groupId),
    availableWorkerCapabilityCatalogMemberCount:
      params.availableWorkerCapabilityCatalog.reduce(
        (total, group) => total + group.memberCount,
        0,
      ),
    workerCapabilityAffordanceContextIncluded:
      params.workerCapabilityAffordances.length > 0,
    availableWorkerCapabilityAffordanceCount:
      params.workerCapabilityAffordances.length,
    availableWorkerCapabilityAffordanceEffectCounts:
      workerCapabilityEffectCounts,
    workerCapabilityAffordancePurposeCharacterCount:
      params.workerCapabilityAffordances.reduce(
        (total, affordance) => total + affordance.purpose.length,
        0,
      ),
    schemaCharacterCount: JSON.stringify(params.format.schema).length,
    configuredInstructionBlockCount: params.configuredInstructionBlockCount,
    configuredInstructionCharacterCount:
      params.configuredInstructionCharacterCount,
    configuredInstructionRefs: params.configuredInstructionRefs,
    configuredInstructionContentHashes:
      params.configuredInstructionContentHashes,
    estimatedInputTokens: params.context.budget.estimatedInputTokens,
    availableInputTokens: params.context.budget.availableInputTokens,
    allowedActions:
      params.allowedRoleIds.length > 0
        ? [...SUPERVISOR_DECISION_ACTIONS]
        : ["respond"],
    allowedRoleIds: [...params.allowedRoleIds],
  });
}

export function traceSupervisorChildResultProjected(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  resume: RoleChildReturnContext;
  continuationMessageCount: number;
}): void {
  const returnedChild = params.resume.completedChildren.find(
    (child) =>
      child.childCallId === params.resume.returnedChildCallId &&
      child.resultRef === params.resume.returnedResultRef,
  );
  if (!returnedChild) {
    throw new Error("supervisor_resume_result_mismatch");
  }
  traceDebug(SUPERVISOR_LOG_SCOPE, "child_result.projected", {
    ...baseFields(params.diagnostic),
    childCallId: returnedChild.childCallId,
    resultRef: returnedChild.resultRef,
    childRoleId: returnedChild.roleId,
    childOutcome: returnedChild.outcome,
    objectiveLength: returnedChild.objective.length,
    workingDirectoryIncluded: returnedChild.workingDirectory !== undefined,
    workingDirectoryLength: returnedChild.workingDirectory?.length ?? 0,
    summaryLength: returnedChild.summary.length,
    completedChildResultCount: params.resume.completedChildren.length,
    completedChildCallIds: params.resume.completedChildren.map(
      (child) => child.childCallId,
    ),
    completedResultRefs: params.resume.completedChildren.map(
      (child) => child.resultRef,
    ),
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
    completedChildObjectiveLength: params.resume.completedChildren.reduce(
      (total, child) => total + child.objective.length,
      0,
    ),
    completedChildSummaryLength: params.resume.completedChildren.reduce(
      (total, child) => total + child.summary.length,
      0,
    ),
    continuationMessageCount: params.continuationMessageCount,
  });
}

export function traceSupervisorEnvelopeAccepted(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  outputLength: number;
  keyCount: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "output.envelope.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    rootType: "object",
    keyCount: params.keyCount,
  });
}

export function traceSupervisorEnvelopeRejected(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  outputLength: number;
  issues: readonly SupervisorDecisionValidationIssue[];
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "output.envelope.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function traceSupervisorDecisionAccepted(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  decision: SupervisorRoutingDecision;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "decision.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    selectedAction: params.decision.action,
    ...workingDirectoryDiagnosticFields(params.decision),
    ...(params.decision.title
      ? { titleLength: params.decision.title.length }
      : {}),
    ...(params.decision.acknowledgement
      ? { acknowledgementLength: params.decision.acknowledgement.length }
      : {}),
    ...(params.decision.action === "invoke_role"
      ? {
          selectedRoleId: params.decision.roleId,
          ...("objective" in params.decision
            ? { objectiveLength: params.decision.objective.length }
            : { objectiveLength: 0 }),
          ...(params.decision.roleId === "worker" &&
          params.decision.workerCapabilityScope
            ? {
                workerCapabilityScopeGroupCount:
                  params.decision.workerCapabilityScope.catalogGroupIds.length,
                workerCapabilityScopeGroupIds:
                  params.decision.workerCapabilityScope.catalogGroupIds,
              }
            : {}),
        }
      : {}),
  });
}

export function traceSupervisorAcknowledgementNormalized(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  originalLength: number;
  normalizedLength: number;
  maximumLength: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "decision.acknowledgement_normalized", {
    ...baseFields(params.diagnostic),
    reason: "maximum_length_exceeded",
    originalLength: params.originalLength,
    normalizedLength: params.normalizedLength,
    maximumLength: params.maximumLength,
  });
}

export function traceSupervisorDecisionRejected(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  issues: readonly SupervisorDecisionValidationIssue[];
  selectedAction?: SupervisorDecision["action"];
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "decision.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    ...(params.selectedAction ? { selectedAction: params.selectedAction } : {}),
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function traceSupervisorModelStarted(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  messageCount: number;
  messageCharacterCount: number;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowedRoleIds: readonly SupervisorDelegateRoleId[];
  availableWorkerCapabilityCatalog: readonly WorkerCapabilityCatalogGroup[];
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "model.started", {
    ...baseFields(params.diagnostic),
    messageCount: params.messageCount,
    messageCharacterCount: params.messageCharacterCount,
    includeAcknowledgement: params.includeAcknowledgement,
    includeTitle: params.includeTitle,
    allowedActions:
      params.allowedRoleIds.length > 0
        ? [...SUPERVISOR_DECISION_ACTIONS]
        : ["respond"],
    allowedRoleIds: [...params.allowedRoleIds],
    availableWorkerCapabilityCatalogGroupCount:
      params.availableWorkerCapabilityCatalog.length,
    availableWorkerCapabilityCatalogGroupIds:
      params.availableWorkerCapabilityCatalog.map((group) => group.groupId),
  });
}

export function traceSupervisorModelCompleted(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  decision: SupervisorDecision | SupervisorRoutingDecision;
  durationMs: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "model.completed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    selectedAction: params.decision.action,
    ...workingDirectoryDiagnosticFields(params.decision),
    ...(params.decision.action === "invoke_role"
      ? {
          selectedRoleId: params.decision.roleId,
          ...(params.decision.roleId === "worker" &&
          params.decision.workerCapabilityScope
            ? {
                workerCapabilityScopeGroupCount:
                  params.decision.workerCapabilityScope.catalogGroupIds.length,
                workerCapabilityScopeGroupIds:
                  params.decision.workerCapabilityScope.catalogGroupIds,
              }
            : {}),
        }
      : {}),
  });
}

export function traceSupervisorWorkingDirectoryContextProjected(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  sourceContext: RequestContextProjection;
  messages: readonly Readonly<{ content: string }>[];
  format: ModelGatewayJsonSchemaFormat;
  frozenDecision: SupervisorWorkingDirectoryRoutingDecision;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "context.projected", {
    ...baseFields(params.diagnostic),
    selectedHistoryMessageCount:
      params.sourceContext.selectedHistoryMessageIds.length,
    omittedHistoryMessageCount:
      params.sourceContext.omittedHistoryMessageIds.length,
    messageCount: params.messages.length,
    messageCharacterCount: params.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    referenceMessageCount: 1,
    frozenRoleId: params.frozenDecision.roleId,
    frozenObjectiveLength: params.frozenDecision.objective.length,
    schemaCharacterCount: JSON.stringify(params.format.schema).length,
    sourceContextEstimatedInputTokens:
      params.sourceContext.budget.estimatedInputTokens,
    availableInputTokens: params.sourceContext.budget.availableInputTokens,
  });
}

export function traceSupervisorWorkingDirectoryOutputAccepted(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  outputLength: number;
  workingDirectoryLength: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "working_directory.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    outputLength: params.outputLength,
    workingDirectoryIncluded: true,
    workingDirectoryLength: params.workingDirectoryLength,
  });
}

export function traceSupervisorWorkingDirectoryOutputRejected(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  outputLength: number;
  validationStage: "json_envelope" | "domain_parser";
  issues: readonly SupervisorDecisionValidationIssue[];
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "working_directory.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: params.validationStage,
    outputLength: params.outputLength,
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function traceSupervisorWorkingDirectoryModelStarted(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  messageCount: number;
  messageCharacterCount: number;
  frozenDecision: SupervisorWorkingDirectoryRoutingDecision;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "model.started", {
    ...baseFields(params.diagnostic),
    messageCount: params.messageCount,
    messageCharacterCount: params.messageCharacterCount,
    frozenRoleId: params.frozenDecision.roleId,
    frozenObjectiveLength: params.frozenDecision.objective.length,
    outputContract: "working_directory_only",
  });
}

export function traceSupervisorDecisionPhaseSuperseded(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  routingSteeringVersion: number;
  currentSteeringVersion: number;
  workingDirectorySteeringVersion?: number;
  checkpoint: "before_working_directory" | "after_working_directory";
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "decision.phase_superseded", {
    ...baseFields(params.diagnostic),
    checkpoint: params.checkpoint,
    routingSteeringVersion: params.routingSteeringVersion,
    currentSteeringVersion: params.currentSteeringVersion,
    ...(params.workingDirectorySteeringVersion === undefined
      ? {}
      : {
          workingDirectorySteeringVersion:
            params.workingDirectorySteeringVersion,
        }),
  });
}

export function traceSupervisorModelFailed(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  durationMs: number;
  errorType: string;
  invalidStructuredOutput: boolean;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "model.failed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    errorType: params.errorType,
    invalidStructuredOutput: params.invalidStructuredOutput,
  });
}

export function traceSupervisorDispatchUnsupported(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  roleId: SupervisorDelegateRoleId;
  objectiveLength: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "dispatch.unsupported", {
    ...baseFields(params.diagnostic),
    selectedAction: "invoke_role",
    selectedRoleId: params.roleId,
    objectiveLength: params.objectiveLength,
  });
}

function baseFields(
  diagnostic: SupervisorDecisionDiagnosticContext,
): Record<string, unknown> {
  return {
    requestId: diagnostic.requestId,
    role: SUPERVISOR_ROLE_ID,
    modelStep: diagnostic.modelStep,
    ...(diagnostic.rootCallId ? { rootCallId: diagnostic.rootCallId } : {}),
    ...(diagnostic.callId ? { callId: diagnostic.callId } : {}),
    ...(diagnostic.parentCallId !== undefined
      ? { parentCallId: diagnostic.parentCallId }
      : {}),
    ...(diagnostic.depth !== undefined ? { depth: diagnostic.depth } : {}),
    ...(diagnostic.invocationAttempt !== undefined
      ? { invocationAttempt: diagnostic.invocationAttempt }
      : {}),
    ...(diagnostic.decisionPhase
      ? { decisionPhase: diagnostic.decisionPhase }
      : {}),
  };
}

function boundedIssues(
  issues: readonly SupervisorDecisionValidationIssue[],
): readonly Readonly<{ code: string; path: string }>[] {
  return issues.map(({ code, path }) => ({ code, path }));
}

function workingDirectoryDiagnosticFields(
  decision: SupervisorDecision | SupervisorRoutingDecision,
): Readonly<{
  workingDirectoryIncluded: boolean;
  workingDirectoryLength: number;
}> {
  const workingDirectory =
    decision.action === "invoke_role" &&
    (decision.roleId === "planner" || decision.roleId === "worker") &&
    "workingDirectory" in decision
      ? decision.workingDirectory
      : undefined;
  return {
    workingDirectoryIncluded: workingDirectory !== undefined,
    workingDirectoryLength: workingDirectory?.length ?? 0,
  };
}
