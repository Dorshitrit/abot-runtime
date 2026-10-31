import { projectUnsharedSuperDependencyResults } from "../../../context/super-dependency-observations.js";
import { resolveConfiguredStepInstructionMetadata } from "../../../config/runner/step-instructions.js";
import {
  assessRequestMessagesBudget,
  projectRequestContext,
} from "../../../context/request-context.js";
import { buildSessionArtifactPathsMessage } from "../../../context/session-artifact-paths.js";
import { resolveModelContextBudget } from "../../../model/model-context-budget.js";
import { hasSuperContextContract } from "../../../context/super-context-policy.js";
import type { WorkerCapabilityDescriptor } from "../../../orchestration/worker-capabilities/index.js";
import {
  buildWorkerCapabilityExecutionInstructions,
  buildWorkerDecisionInstructions,
} from "../prompt.js";
import { WORKER_SESSION_ARTIFACT_PATH_PROJECTION_MAX } from "../runtime-path-refinement.js";
import { buildWorkerEvidenceAssessmentMessage } from "../evidence-assessment.js";
import {
  buildWorkerEvidenceCapabilitySelectionInstructions,
  WORKER_ACCEPTED_EVIDENCE_INSTRUCTION,
} from "../evidence-stage-instructions.js";
import { projectWorkerCapabilityExecutionGuidance } from "./execution-guidance.js";
import type {
  PreparedWorkerDecisionSession,
  PreparedWorkerPromptContext,
  PreparedWorkerReferenceContext,
  ProjectedWorkerDecisionContext,
  WorkerPendingCapabilitySelection,
} from "./types.js";

export function prepareWorkerPromptContext(
  session: PreparedWorkerDecisionSession,
  references: PreparedWorkerReferenceContext,
): PreparedWorkerPromptContext {
  const { request, options, capabilitySelection } = session;
  const { dependencyResults, operationSupervision, resume } =
    session.canonicalState;
  const {
    selectedCapabilityExecution,
    selectedCapabilityBatchExecution,
    executionPending: capabilityExecutionPending,
  } = capabilitySelection;
  const {
    allowedActions,
    capabilitiesAvailable,
    capabilitySelectionRejection,
    capabilityCatalogProjection,
  } = session.contract;
  const { requestToolResultsMessage } = references;
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: session.diagnostic.modelStep,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const baseInstructions = capabilityExecutionPending
    ? buildWorkerCapabilityExecutionInstructions({
        workingDirectoryAvailable: options.call.workingDirectory !== undefined,
        selectedCapabilityBatchExecution:
          selectedCapabilityBatchExecution !== undefined,
        hasDependencyResults: dependencyResults.length > 0,
        hasRequestToolResults: requestToolResultsMessage !== undefined,
        returnResultAvailable: allowedActions.includes("return_result"),
        returnFailureAvailable: allowedActions.includes("return_failure"),
      })
    : options.evidenceAssessment
      ? buildWorkerEvidenceCapabilitySelectionInstructions()
      : buildWorkerDecisionInstructions({
        capabilitiesAvailable,
        workingDirectoryAvailable: options.call.workingDirectory !== undefined,
        hasCapabilityResult: resume !== undefined,
        hasDependencyResults: dependencyResults.length > 0,
        hasRequestToolResults: options.requestToolResults.results.length > 0,
        hasOperationSupervision: operationSupervision !== undefined,
        hasCapabilitySelectionRejection:
          capabilitySelectionRejection !== undefined,
        capabilityCatalogProjection,
      });
  const builtInInstructions = [
    baseInstructions,
    ...(capabilityExecutionPending && options.evidenceAssessment
      ? [WORKER_ACCEPTED_EVIDENCE_INSTRUCTION]
      : []),
    ...(capabilityExecutionPending
      ? projectWorkerCapabilityExecutionGuidance({
          selectedCapabilityExecution,
          selectedCapabilityBatchExecution,
        })
      : []),
  ].join("\n\n");
  const configuredInstructionMetadata =
    resolveConfiguredStepInstructionMetadata({
      runnerConfig: request.runnerConfig,
      modelStep: session.diagnostic.modelStep,
    });
  const prompt = buildWorkerAssignmentPrompt(session);

  return Object.freeze({
    budget,
    baseInstructions,
    instructions: builtInInstructions,
    configuredInstructionMetadata,
    prompt,
  });
}

export function projectWorkerDecisionContext(
  session: PreparedWorkerDecisionSession,
  references: PreparedWorkerReferenceContext,
  promptContext: PreparedWorkerPromptContext,
): ProjectedWorkerDecisionContext {
  const {
    request,
    options,
    diagnostic,
    eligibleSessionArtifactPaths,
    sessionArtifactPathAvailableCount,
  } = session;
  const { capabilities, executionPending: capabilityExecutionPending } =
    session.capabilitySelection;
  const { format } = session.contract;
  const {
    requestToolResultsMessage,
    baseReferenceMessages,
    continuationMessages,
  } = references;
  const { budget, instructions, prompt } = promptContext;
  const authority =
    session.canonicalState.canonicalSource?.head.policy.authority;
  const usesSharedEvidenceContext =
    authority !== undefined &&
    hasSuperContextContract(authority, "delegated.worker");
  const sessionArtifactPathProjection = options.evidenceAssessment
    ? undefined
    : buildSessionArtifactPathsMessage({
        targets: eligibleSessionArtifactPaths,
        availableTargetCount: sessionArtifactPathAvailableCount,
        applicable: usesSharedEvidenceContext
          ? capabilities.some(
              (capability) =>
                (capability.runtimePathControlIds?.length ?? 0) > 0,
            )
          : phaseAuthorsRuntimePathControl(
              capabilities,
              capabilityExecutionPending,
            ),
        maxTargets: WORKER_SESSION_ARTIFACT_PATH_PROJECTION_MAX,
        fits: (message) =>
          assessRequestMessagesBudget({
            messages: [
              { role: "system", content: instructions },
              message,
              ...baseReferenceMessages,
              { role: "user", content: prompt },
              ...continuationMessages,
            ],
            format,
            budget,
          }).fits,
      });
  const referenceMessages = Object.freeze([
    ...(sessionArtifactPathProjection
      ? [sessionArtifactPathProjection.message]
      : []),
    ...(options.evidenceAssessment
      ? [
          ...options.evidenceAssessment.contextMessages,
          buildWorkerEvidenceAssessmentMessage(options.evidenceAssessment),
        ]
      : baseReferenceMessages),
  ]);
  // Reuse original message objects so evidence provenance survives every phase.
  const sharedContextMessages =
    options.evidenceAssessment?.contextMessages ??
    Object.freeze([
      ...referenceMessages,
      Object.freeze({ role: "user" as const, content: prompt }),
      ...continuationMessages,
    ].map((message) => Object.freeze(message)));
  const context = projectRequestContext({
    instructions,
    format,
    historyMessages: [],
    prompt,
    referenceMessages,
    ...(!options.evidenceAssessment && continuationMessages.length > 0
      ? { continuationMessages }
      : {}),
    budget,
    diagnostic,
    ...(request.onEvent ? { onEvent: request.onEvent } : {}),
    deferCompactionFailure: true,
  });

  return Object.freeze({
    sessionArtifactPathProjection,
    referenceMessages,
    sharedContextMessages,
    context,
  });
}

export function buildWorkerAssignmentPrompt(
  session: PreparedWorkerDecisionSession,
): string {
  const { callIdentity, objective, options } = session;
  const { dependencyResults, operationSupervision } = session.canonicalState;
  const {
    pendingCapabilitySelection,
    pendingCapabilityBatchSelection,
    executionPending: capabilityExecutionPending,
  } = session.capabilitySelection;
  const {
    availableCapabilityAffordances,
    capabilitiesAvailable,
    capabilityPromptPayload,
    capabilitySelectionRejection,
  } = session.contract;
  if (options.evidenceAssessment && !capabilityExecutionPending) {
    return JSON.stringify({
      kind: "runtime_worker_capability_selection",
      callId: callIdentity.callId,
      ...(capabilitySelectionRejection ? { capabilitySelectionRejection } : {}),
    });
  }
  const projectedDependencies = options.evidenceAssessment && capabilityExecutionPending
    ? projectUnsharedSuperDependencyResults(
        dependencyResults, options.evidenceAssessment.contextMessages,
        session.canonicalState.canonicalSource?.head.policy.authority,
        callIdentity,
      )
    : dependencyResults;
  const identity = {
    callId: callIdentity.callId,
    parentCallId: callIdentity.parentCallId,
    depth: callIdentity.depth,
    invocationAttempt: callIdentity.invocationAttempt,
    objective,
    ...(options.call.workingDirectory !== undefined
      ? { workingDirectory: options.call.workingDirectory }
      : {}),
    ...(projectedDependencies.length > 0 ? { dependencyResults: projectedDependencies } : {}),
    ...(operationSupervision ? { operationSupervision } : {}),
  };

  if (capabilityExecutionPending) {
    return JSON.stringify({
      kind: "runtime_worker_capability_execution_assignment",
      ...identity,
      selectedCapabilityAffordances: availableCapabilityAffordances,
      ...(pendingCapabilitySelection
        ? {
            pendingCapabilitySelection:
              projectPendingCapabilityExecutionAssignment(
                pendingCapabilitySelection,
              ),
          }
        : {}),
      ...(pendingCapabilityBatchSelection
        ? {
            pendingCapabilityBatchSelection:
              pendingCapabilityBatchSelection.map(
                projectPendingCapabilityExecutionAssignment,
              ),
          }
        : {}),
    });
  }

  return JSON.stringify({
    kind: "runtime_worker_assignment",
    ...identity,
    capabilitiesAvailable,
    ...(capabilitiesAvailable ? capabilityPromptPayload : {}),
    ...(capabilitySelectionRejection ? { capabilitySelectionRejection } : {}),
    availableChildRoleIds: [],
  });
}

function projectPendingCapabilityExecutionAssignment(
  pending: WorkerPendingCapabilitySelection,
): Readonly<{
  capabilityId: string;
  authoringObjective?: string;
  selectionControls?: WorkerPendingCapabilitySelection["selectionControls"];
}> {
  return Object.freeze({
    capabilityId: pending.capabilityId,
    ...(pending.authoringObjective
      ? { authoringObjective: pending.authoringObjective }
      : {}),
    ...(pending.selectionControls
      ? { selectionControls: pending.selectionControls }
      : {}),
  });
}

function phaseAuthorsRuntimePathControl(
  capabilities: readonly WorkerCapabilityDescriptor[],
  capabilityExecutionPending: boolean,
): boolean {
  return capabilities.some((capability) => {
    const selectionControlIds = new Set(capability.selectionControlIds ?? []);
    return (capability.runtimePathControlIds ?? []).some((controlId) =>
      capabilityExecutionPending
        ? !selectionControlIds.has(controlId)
        : selectionControlIds.has(controlId),
    );
  });
}
