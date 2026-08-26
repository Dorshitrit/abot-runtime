import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RoleCallAssignmentScopeView } from "../../orchestration/role-calls/index.js";
import {
  WORKER_ROLE_ID,
  type WorkerCapabilityResumeContext,
  type WorkerSettledCapabilityResult,
  type WorkerControlDecision,
  type WorkerDecisionDiagnosticContext,
  type WorkerDecisionValidationIssue,
} from "./contracts.js";
import type { WorkerCapabilitySelectionRejection } from "./capability-selection-rejection.js";
import { WORKER_COMPLETION_EVIDENCE_POLICY } from "./prompt.js";

const WORKER_LOG_SCOPE = "runtime.worker";

export function traceWorkerContextProjected(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  contextProjection: "worker_assignment" | "capability_execution_capsule";
  objectiveLength: number;
  workingDirectory?: string;
  capabilityIds: readonly string[];
  capabilityAffordanceCharacterCount: number;
  capabilityCatalogProjection: "grouped" | "flat";
  capabilityCatalogGroupCount: number;
  capabilityCatalogMembershipCount: number;
  capabilityCatalogGroupedCharacterCount: number;
  capabilityCatalogFlatCharacterCount: number;
  referenceMessageCount: number;
  continuationMessageCount: number;
  settledCapabilityResultCount: number;
  settledCapabilitySummaryLength: number;
  settledCapabilityReferenceDataSourceLength: number;
  requestToolResultsProjection: "none" | "canonical" | "semantic_compaction";
  requestToolResultsProjectedCharacterCount: number;
  dependencyResultRefs: readonly string[];
  dependencyResultSummaryLength: number;
  assignmentScope?: RoleCallAssignmentScopeView;
  allowedActions: readonly WorkerControlDecision["action"][];
  selectedCapabilityId?: string;
  selectedCapabilityIds?: readonly string[];
  capabilitySelectionRejection?: WorkerCapabilitySelectionRejection;
  executionGuidanceCharacterCount: number;
  baseInstructionCharacterCount: number;
  configuredInstructionBlockCount: number;
  configuredInstructionCharacterCount: number;
  configuredInstructionRefs: readonly string[];
  configuredInstructionContentHashes: readonly string[];
  sessionArtifactPathSelectionDeferred: boolean;
  sessionArtifactPathAvailableCount: number;
  sessionArtifactPathBoundedCount: number;
  sessionArtifactPathEligibleCount: number;
  sessionArtifactPathProjectedCount: number;
  sessionArtifactPathOmittedCount: number;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "context.projected", {
    ...baseFields(params.diagnostic),
    contextProjection: params.contextProjection,
    objectiveLength: params.objectiveLength,
    workingDirectoryIncluded: params.workingDirectory !== undefined,
    workingDirectoryLength: params.workingDirectory?.length ?? 0,
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
      params.capabilityIds.length > 0 ||
      params.settledCapabilityResultCount > 0,
    availableCapabilityCount: params.capabilityIds.length,
    availableCapabilityIds: params.capabilityIds,
    availableCapabilityAffordanceCharacterCount:
      params.capabilityAffordanceCharacterCount,
    capabilityCatalogProjection: params.capabilityCatalogProjection,
    capabilityCatalogGroupCount: params.capabilityCatalogGroupCount,
    capabilityCatalogMembershipCount: params.capabilityCatalogMembershipCount,
    capabilityCatalogGroupedCharacterCount:
      params.capabilityCatalogGroupedCharacterCount,
    capabilityCatalogFlatCharacterCount:
      params.capabilityCatalogFlatCharacterCount,
    executionGuidanceIncluded: params.executionGuidanceCharacterCount > 0,
    executionGuidanceCharacterCount: params.executionGuidanceCharacterCount,
    ...(params.selectedCapabilityId
      ? { selectedCapabilityId: params.selectedCapabilityId }
      : {}),
    ...(params.selectedCapabilityIds
      ? {
          selectedCapabilityIds: params.selectedCapabilityIds,
          selectedCapabilityCount: params.selectedCapabilityIds.length,
        }
      : {}),
    ...(params.capabilitySelectionRejection
      ? {
          capabilitySelectionRejectionIncluded: true,
          rejectedSelectionKind:
            params.capabilitySelectionRejection.rejectedSelectionKind,
          rejectedCapabilityIds:
            params.capabilitySelectionRejection.rejectedCapabilityIds,
          rejectedInvocationCount:
            params.capabilitySelectionRejection.rejectedInvocationCount,
        }
      : {}),
    settledCapabilityResultCount: params.settledCapabilityResultCount,
    settledCapabilitySummaryLength: params.settledCapabilitySummaryLength,
    settledCapabilityReferenceDataSourceLength:
      params.settledCapabilityReferenceDataSourceLength,
    requestToolResultsProjection: params.requestToolResultsProjection,
    requestToolResultsProjectedCharacterCount:
      params.requestToolResultsProjectedCharacterCount,
    roleDependencyContextIncluded: params.dependencyResultRefs.length > 0,
    dependencyResultCount: params.dependencyResultRefs.length,
    dependencyResultRefs: params.dependencyResultRefs,
    dependencyResultSummaryLength: params.dependencyResultSummaryLength,
    roleAssignmentScopeIncluded: params.assignmentScope !== undefined,
    ...(params.assignmentScope
      ? {
          roleAssignmentScopeCallId: params.assignmentScope.scopeCallId,
          roleAssignmentScopeRoleId: params.assignmentScope.scopeRoleId,
          roleAssignmentScopeObjectiveLength:
            params.assignmentScope.scopeObjective.length,
        }
      : {}),
    availableChildRoleCount: 0,
    schemaCharacterCount: JSON.stringify(params.format.schema).length,
    baseInstructionCharacterCount: params.baseInstructionCharacterCount,
    configuredInstructionBlockCount: params.configuredInstructionBlockCount,
    configuredInstructionCharacterCount:
      params.configuredInstructionCharacterCount,
    configuredInstructionRefs: params.configuredInstructionRefs,
    configuredInstructionContentHashes:
      params.configuredInstructionContentHashes,
    sessionArtifactPathSelectionDeferred:
      params.sessionArtifactPathSelectionDeferred,
    sessionArtifactPathContextIncluded:
      params.sessionArtifactPathProjectedCount > 0,
    sessionArtifactPathAvailableCount: params.sessionArtifactPathAvailableCount,
    sessionArtifactPathBoundedCount: params.sessionArtifactPathBoundedCount,
    sessionArtifactPathEligibleCount: params.sessionArtifactPathEligibleCount,
    sessionArtifactPathProjectedCount: params.sessionArtifactPathProjectedCount,
    sessionArtifactPathOmittedCount: params.sessionArtifactPathOmittedCount,
    estimatedInputTokens: params.context.budget.estimatedInputTokens,
    availableInputTokens: params.context.budget.availableInputTokens,
    allowedActions: params.allowedActions,
  });
}

export function traceWorkerCapabilitySelectionReopened(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  rejection: WorkerCapabilitySelectionRejection;
  reasonLength: number;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "capability_selection.reopened", {
    ...baseFields(params.diagnostic),
    mappedOutcome: "capability_selection_reopened",
    rejectedSelectionKind: params.rejection.rejectedSelectionKind,
    rejectedCapabilityIds: params.rejection.rejectedCapabilityIds,
    rejectedInvocationCount: params.rejection.rejectedInvocationCount,
    rejectionReasonLength: params.reasonLength,
    rejectedSelectionExecutionStarted: false,
    reopenAttempt: 1,
    maxReopenAttempts: 1,
  });
}

export function traceWorkerCapabilityRefinementSkipped(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  capabilityId: string;
  selectionControlCount: number;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "capability_refinement.skipped", {
    ...baseFields(params.diagnostic),
    capabilityId: params.capabilityId,
    reason: "selection_controls_complete",
    selectionControlCount: params.selectionControlCount,
    remainingControlCount: 0,
    executionGuidanceIncluded: false,
  });
}

export function traceWorkerCapabilityResultProjected(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  resume: WorkerCapabilityResumeContext;
  referenceMessageCount: number;
  continuationMessageCount: number;
}): void {
  const results = requireReturnedCapabilityResults(params.resume);
  traceDebug(WORKER_LOG_SCOPE, "capability_result.projected", {
    ...baseFields(params.diagnostic),
    returnedExecutionIds: results.map((result) => result.executionId),
    returnedCapabilityIds: results.map((result) => result.capabilityId),
    returnedCapabilityCount: results.length,
    ...(results.length === 1
      ? {
          executionId: results[0]!.executionId,
          capabilityId: results[0]!.capabilityId,
          declaredEffect: results[0]!.declaredEffect,
          outcome: results[0]!.outcome,
          observedEffect: results[0]!.observedEffect,
          summaryLength: results[0]!.summary.length,
        }
      : {}),
    capabilityInvocationAttempt: results[0]?.invocationAttempt,
    outcomes: results.map((result) => result.outcome),
    observedEffects: results.map((result) => result.observedEffect),
    returnedSummaryLength: results.reduce(
      (total, result) => total + result.summary.length,
      0,
    ),
    settledCapabilityResultCount: params.resume.settledResults.length,
    settledCapabilityExecutionIds: params.resume.settledResults.map(
      (settled) => settled.executionId,
    ),
    settledCapabilityIds: params.resume.settledResults.map(
      (settled) => settled.capabilityId,
    ),
    settledCapabilitySummaryLength: params.resume.settledResults.reduce(
      (total, settled) => total + settled.summary.length,
      0,
    ),
    referenceMessageCount: params.referenceMessageCount,
    continuationMessageCount: params.continuationMessageCount,
  });
}

export function traceWorkerEnvelopeAccepted(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  outputLength: number;
  keyCount: number;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "output.envelope.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    rootType: "object",
    keyCount: params.keyCount,
  });
}

export function traceWorkerEnvelopeRejected(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  outputLength: number;
  issues: readonly WorkerDecisionValidationIssue[];
}): void {
  traceDebug(WORKER_LOG_SCOPE, "output.envelope.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "json_envelope",
    outputLength: params.outputLength,
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function traceWorkerDecisionAccepted(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  decision: WorkerControlDecision;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "decision.accepted", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    selectedAction: params.decision.action,
    ...decisionFields(params.decision),
  });
}

export function traceWorkerClientIntentPublished(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  capabilityId: string;
  intentLength: number;
  guidanceDecisionIntentLength?: number;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "client_intent.published", {
    ...baseFields(params.diagnostic),
    capabilityId: params.capabilityId,
    intentLength: params.intentLength,
    intentSource: "capability_selection",
    ...(params.guidanceDecisionIntentLength === undefined
      ? {}
      : {
          guidanceDecisionIntentLength: params.guidanceDecisionIntentLength,
          guidanceDecisionIntentChanged:
            params.guidanceDecisionIntentLength !== params.intentLength,
        }),
  });
}

export function traceWorkerClientBatchIntentsPublished(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  capabilityIds: readonly string[];
  intentLengths: readonly number[];
  guidanceDecisionIntentLengths?: readonly number[];
}): void {
  traceDebug(WORKER_LOG_SCOPE, "client_intent.batch_published", {
    ...baseFields(params.diagnostic),
    capabilityIds: params.capabilityIds,
    intentLengths: params.intentLengths,
    capabilityCount: params.capabilityIds.length,
    intentSource: "capability_selection",
    ...(params.guidanceDecisionIntentLengths
      ? {
          guidanceDecisionIntentLengths: params.guidanceDecisionIntentLengths,
        }
      : {}),
  });
}

export function traceWorkerDecisionRejected(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  issues: readonly WorkerDecisionValidationIssue[];
  selectedAction?: WorkerControlDecision["action"];
}): void {
  traceDebug(WORKER_LOG_SCOPE, "decision.rejected", {
    ...baseFields(params.diagnostic),
    validationStage: "domain_parser",
    ...(params.selectedAction ? { selectedAction: params.selectedAction } : {}),
    issueCount: params.issues.length,
    issues: boundedIssues(params.issues),
  });
}

export function traceWorkerModelStarted(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  messageCount: number;
  messageCharacterCount: number;
  allowedActions: readonly WorkerControlDecision["action"][];
}): void {
  traceDebug(WORKER_LOG_SCOPE, "model.started", {
    ...baseFields(params.diagnostic),
    messageCount: params.messageCount,
    messageCharacterCount: params.messageCharacterCount,
    allowedActions: params.allowedActions,
  });
}

export function traceWorkerModelCompleted(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  decision: WorkerControlDecision;
  durationMs: number;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "model.completed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    selectedAction: params.decision.action,
    ...decisionFields(params.decision),
  });
}

function decisionFields(
  decision: WorkerControlDecision,
): Record<string, unknown> {
  if (decision.action === "return_result") {
    return {
      mappedOutcome: "result_authoring_required",
    };
  }
  if (decision.action === "return_failure") {
    return {
      resultLength: decision.reason.length,
      mappedOutcome: "failed",
    };
  }
  if (decision.action === "invoke_capabilities") {
    return {
      capabilityIds: decision.invocations.map(
        (invocation) => invocation.capabilityId,
      ),
      capabilityCount: decision.invocations.length,
      intentLengths: decision.invocations.map(
        (invocation) => invocation.intent.length,
      ),
      selectionControlsIncluded: decision.invocations.some(
        (invocation) => "selectionControls" in invocation,
      ),
      selectionControlKeyCounts: decision.invocations.map((invocation) =>
        "selectionControls" in invocation && invocation.selectionControls
          ? Object.keys(invocation.selectionControls).length
          : 0,
      ),
      controlsIncluded: decision.invocations.every(
        (invocation) => "controls" in invocation,
      ),
      ...(decision.invocations.every((invocation) => "controls" in invocation)
        ? {
            controlsKeyCounts: decision.invocations.map(
              (invocation) =>
                Object.keys(
                  (invocation as { controls: Record<string, unknown> })
                    .controls,
                ).length,
            ),
          }
        : {}),
      mappedOutcome: "capability_batch_requested",
    };
  }
  return {
    capabilityId: decision.capabilityId,
    intentLength: decision.intent.length,
    selectionControlsIncluded: "selectionControls" in decision,
    ...("selectionControls" in decision && decision.selectionControls
      ? {
          selectionControlKeyCount: Object.keys(decision.selectionControls)
            .length,
        }
      : {}),
    controlsIncluded: "controls" in decision,
    ...("controls" in decision
      ? { controlsKeyCount: Object.keys(decision.controls).length }
      : {}),
    mappedOutcome: "capability_requested",
  };
}

export function traceWorkerModelFailed(params: {
  diagnostic: WorkerDecisionDiagnosticContext;
  durationMs: number;
  errorType: string;
  invalidStructuredOutput: boolean;
}): void {
  traceDebug(WORKER_LOG_SCOPE, "model.failed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    errorType: params.errorType,
    invalidStructuredOutput: params.invalidStructuredOutput,
  });
}

function baseFields(
  diagnostic: WorkerDecisionDiagnosticContext,
): Record<string, unknown> {
  return {
    requestId: diagnostic.requestId,
    role: WORKER_ROLE_ID,
    modelStep: diagnostic.modelStep,
    decisionPhase: diagnostic.decisionPhase,
    callId: diagnostic.callId,
    parentCallId: diagnostic.parentCallId,
    depth: diagnostic.depth,
    invocationAttempt: diagnostic.invocationAttempt,
    completionEvidencePolicy: WORKER_COMPLETION_EVIDENCE_POLICY,
  };
}

function boundedIssues(
  issues: readonly WorkerDecisionValidationIssue[],
): readonly Readonly<{ code: string; path: string }>[] {
  return issues.map(({ code, path }) => ({ code, path }));
}

function requireReturnedCapabilityResults(
  resume: WorkerCapabilityResumeContext,
): readonly WorkerSettledCapabilityResult[] {
  const returnedExecutionIds =
    "returnedExecutionIds" in resume
      ? resume.returnedExecutionIds
      : [resume.returnedExecutionId];
  const results = resume.settledResults.slice(-returnedExecutionIds.length);
  if (
    results.length !== returnedExecutionIds.length ||
    !results.every(
      (result, index) => result.executionId === returnedExecutionIds[index],
    )
  ) {
    throw new Error("worker_capability_resume_result_missing");
  }
  return results;
}
