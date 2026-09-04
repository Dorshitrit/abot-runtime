import { resolveConfiguredStepInstructionMetadata } from "../../../config/runner/step-instructions.js";
import {
  assessRequestMessagesBudget,
  projectRequestContext,
} from "../../../context/request-context.js";
import { buildSessionArtifactPathsMessage } from "../../../context/session-artifact-paths.js";
import { resolveModelContextBudget } from "../../../model/model-context-budget.js";
import type { WorkerCapabilityDescriptor } from "../../../orchestration/worker-capabilities/index.js";
import {
  buildWorkerCapabilityExecutionInstructions,
  buildWorkerDecisionInstructions,
} from "../prompt.js";
import { WORKER_SESSION_ARTIFACT_PATH_PROJECTION_MAX } from "../runtime-path-refinement.js";
import type {
  PreparedWorkerDecisionSession,
  PreparedWorkerPromptContext,
  PreparedWorkerReferenceContext,
  ProjectedWorkerDecisionContext,
  WorkerPendingCapabilitySelection,
  WorkerSelectedCapabilityBatchExecution,
  WorkerSelectedCapabilityExecution,
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
    ...(capabilityExecutionPending
      ? projectCapabilityExecutionGuidance({
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
  const sessionArtifactPathProjection = buildSessionArtifactPathsMessage({
    targets: eligibleSessionArtifactPaths,
    availableTargetCount: sessionArtifactPathAvailableCount,
    applicable: phaseAuthorsRuntimePathControl(
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
    ...baseReferenceMessages,
  ]);
  const context = projectRequestContext({
    instructions,
    format,
    historyMessages: [],
    prompt,
    referenceMessages,
    ...(continuationMessages.length > 0 ? { continuationMessages } : {}),
    budget,
    diagnostic,
    ...(request.onEvent ? { onEvent: request.onEvent } : {}),
    deferCompactionFailure: true,
  });

  return Object.freeze({
    sessionArtifactPathProjection,
    referenceMessages,
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
  const identity = {
    callId: callIdentity.callId,
    parentCallId: callIdentity.parentCallId,
    depth: callIdentity.depth,
    invocationAttempt: callIdentity.invocationAttempt,
    objective,
    ...(options.call.workingDirectory !== undefined
      ? { workingDirectory: options.call.workingDirectory }
      : {}),
    ...(dependencyResults.length > 0 ? { dependencyResults } : {}),
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

function projectCapabilityExecutionGuidance(
  options: Readonly<{
    selectedCapabilityExecution?: WorkerSelectedCapabilityExecution;
    selectedCapabilityBatchExecution?: WorkerSelectedCapabilityBatchExecution;
  }>,
): readonly string[] {
  if (options.selectedCapabilityExecution) {
    return Object.freeze([
      "### SELECTED CAPABILITY EXECUTION GUIDANCE",
      options.selectedCapabilityExecution.guidance.length > 0
        ? options.selectedCapabilityExecution.guidance
        : "No additional execution guidance is supplied for this capability.",
      "### END SELECTED CAPABILITY EXECUTION GUIDANCE",
    ]);
  }
  if (options.selectedCapabilityBatchExecution) {
    return Object.freeze([
      "### SELECTED CAPABILITY BATCH EXECUTION GUIDANCE",
      ...options.selectedCapabilityBatchExecution.invocations.flatMap(
        (invocation, index) => [
          `#### Invocation ${index + 1}: ${invocation.capabilityId}`,
          invocation.guidance.length > 0
            ? invocation.guidance
            : "No additional execution guidance is supplied for this invocation.",
        ],
      ),
      "### END SELECTED CAPABILITY BATCH EXECUTION GUIDANCE",
    ]);
  }
  return Object.freeze([]);
}
