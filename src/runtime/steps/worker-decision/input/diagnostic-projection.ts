import { projectWorkerCapabilityAffordances } from "../capability-affordances.js";
import { projectWorkerCapabilitySelectionCatalog } from "../capability-catalog.js";
import {
  CAPABILITY_CONTROLS_MODEL_STEP,
  projectWorkerDecisionCallIdentity,
  WORKER_DECISION_MODEL_STEP,
  type WorkerDecisionDiagnosticContext,
} from "../contracts.js";
import {
  traceWorkerCapabilityResultProjected,
  traceWorkerContextProjected,
} from "../diagnostics.js";
import { WORKER_SESSION_ARTIFACT_PATH_PROJECTION_MAX } from "../runtime-path-refinement.js";
import type {
  PreparedWorkerDecisionAssembly,
  PreparedWorkerDecisionSession,
  WorkerDecisionInputOptions,
  WorkerSelectedCapabilityBatchExecution,
  WorkerSelectedCapabilityExecution,
} from "./types.js";

export function traceWorkerDecisionInputProjection(
  session: PreparedWorkerDecisionSession,
  assembly: PreparedWorkerDecisionAssembly,
): void {
  const { options, diagnostic, objective, sessionArtifactPathAvailableCount } =
    session;
  const { assignmentScope, dependencyResults, resume } = session.canonicalState;
  const {
    capabilities,
    selectedCapabilityExecution,
    selectedCapabilityBatchExecution,
    executionPending: capabilityExecutionPending,
  } = session.capabilitySelection;
  const {
    availableCapabilityIds,
    availableCapabilityAffordances,
    capabilitiesAvailable,
    sessionArtifactPathSelectionDeferred,
    capabilitySelectionRejection,
    selectionCatalog,
    capabilityCatalogProjection,
    allowedActions,
    format,
  } = session.contract;
  const { requestToolResultsMessage, continuationMessages } =
    assembly.references;
  const { baseInstructions, configuredInstructionMetadata } = assembly.prompt;
  const { context, referenceMessages, sessionArtifactPathProjection } =
    assembly.projection;
  traceWorkerContextProjected({
    diagnostic,
    context,
    format,
    contextProjection: capabilityExecutionPending
      ? "capability_execution_capsule"
      : "worker_assignment",
    objectiveLength: objective.length,
    workingDirectory: options.call.workingDirectory,
    capabilityIds: availableCapabilityIds,
    capabilityAffordanceCharacterCount:
      measureWorkerCapabilityAffordanceCharacters({
        capabilitiesAvailable,
        capabilityExecutionPending,
        availableCapabilityAffordances,
        selectionCatalog,
      }),
    capabilityCatalogProjection,
    capabilityCatalogGroupCount: capabilityExecutionPending
      ? 0
      : selectionCatalog.groupCount,
    capabilityCatalogMembershipCount: capabilityExecutionPending
      ? 0
      : selectionCatalog.membershipCount,
    capabilityCatalogGroupedCharacterCount: capabilityExecutionPending
      ? 0
      : selectionCatalog.groupedCharacterCount,
    capabilityCatalogFlatCharacterCount: selectionCatalog.flatCharacterCount,
    referenceMessageCount: referenceMessages.length,
    continuationMessageCount: continuationMessages.length,
    settledCapabilityResultCount: options.requestToolResults.results.length,
    settledCapabilitySummaryLength: options.requestToolResults.results.reduce(
      (total, result) => total + result.summary.length,
      0,
    ),
    settledCapabilityReferenceDataSourceLength:
      options.requestToolResults.results.reduce(
        (total, result) => total + (result.referenceData?.length ?? 0),
        0,
      ),
    requestToolResultsProjection: resolveRequestToolResultsProjection(options),
    requestToolResultsProjectedCharacterCount:
      requestToolResultsMessage?.content.length ?? 0,
    dependencyResultRefs: dependencyResults.map((result) => result.resultRef),
    dependencyResultSummaryLength: dependencyResults.reduce(
      (total, result) => total + result.summary.length,
      0,
    ),
    assignmentScope,
    allowedActions,
    selectedCapabilityId: selectedCapabilityExecution?.capabilityId,
    selectedCapabilityIds: selectedCapabilityBatchExecution?.invocations.map(
      ({ capabilityId }) => capabilityId,
    ),
    capabilitySelectionRejection,
    executionGuidanceCharacterCount: measureExecutionGuidanceCharacters(
      selectedCapabilityExecution,
      selectedCapabilityBatchExecution,
    ),
    baseInstructionCharacterCount: baseInstructions.length,
    configuredInstructionBlockCount: configuredInstructionMetadata.blockCount,
    configuredInstructionCharacterCount:
      configuredInstructionMetadata.characterCount,
    configuredInstructionRefs: configuredInstructionMetadata.refs,
    configuredInstructionContentHashes:
      configuredInstructionMetadata.contentHashes,
    sessionArtifactPathSelectionDeferred,
    sessionArtifactPathAvailableCount,
    sessionArtifactPathBoundedCount: Math.min(
      sessionArtifactPathAvailableCount,
      WORKER_SESSION_ARTIFACT_PATH_PROJECTION_MAX,
    ),
    sessionArtifactPathEligibleCount:
      session.eligibleSessionArtifactPaths.length,
    sessionArtifactPathProjectedCount:
      sessionArtifactPathProjection?.projectedCount ?? 0,
    sessionArtifactPathOmittedCount:
      sessionArtifactPathAvailableCount -
      (sessionArtifactPathProjection?.projectedCount ?? 0),
  });
  if (resume) {
    traceWorkerCapabilityResultProjected({
      diagnostic,
      resume,
      referenceMessageCount: referenceMessages.length,
      continuationMessageCount: continuationMessages.length,
    });
  }
}

export function resolveWorkerDecisionDiagnostic(
  requestId: string,
  options: WorkerDecisionInputOptions,
  callIdentity: ReturnType<typeof projectWorkerDecisionCallIdentity>,
): WorkerDecisionDiagnosticContext {
  if (options.diagnostic) return options.diagnostic;
  return {
    requestId,
    ...resolveWorkerDecisionPhase(options),
    ...callIdentity,
  };
}

function resolveWorkerDecisionPhase(
  options: WorkerDecisionInputOptions,
): Pick<WorkerDecisionDiagnosticContext, "modelStep" | "decisionPhase"> {
  if (hasPendingCapabilityExecution(options)) {
    return {
      modelStep: CAPABILITY_CONTROLS_MODEL_STEP,
      decisionPhase: "capability_execution",
    };
  }
  return {
    modelStep: WORKER_DECISION_MODEL_STEP,
    decisionPhase: "capability_selection",
  };
}

function hasPendingCapabilityExecution(
  options: WorkerDecisionInputOptions,
): boolean {
  return Boolean(
    options.selectedCapabilityExecution ||
    options.selectedCapabilityBatchExecution,
  );
}

function measureWorkerCapabilityAffordanceCharacters(
  params: Readonly<{
    capabilitiesAvailable: boolean;
    capabilityExecutionPending: boolean;
    availableCapabilityAffordances: ReturnType<
      typeof projectWorkerCapabilityAffordances
    >;
    selectionCatalog: ReturnType<
      typeof projectWorkerCapabilitySelectionCatalog
    >;
  }>,
): number {
  if (!params.capabilitiesAvailable) return 0;
  if (!params.capabilityExecutionPending) {
    return params.selectionCatalog.projectedCharacterCount;
  }
  return JSON.stringify({
    selectedCapabilityAffordances: params.availableCapabilityAffordances,
  }).length;
}

function resolveRequestToolResultsProjection(
  options: WorkerDecisionInputOptions,
): "none" | "semantic_compaction" | "canonical" {
  if (options.requestToolResults.results.length === 0) return "none";
  return options.requestToolResultsContextMessage
    ? "semantic_compaction"
    : "canonical";
}

function measureExecutionGuidanceCharacters(
  selectedCapabilityExecution: WorkerSelectedCapabilityExecution | undefined,
  selectedCapabilityBatchExecution:
    | WorkerSelectedCapabilityBatchExecution
    | undefined,
): number {
  if (selectedCapabilityExecution) {
    return selectedCapabilityExecution.guidance.length;
  }
  return (
    selectedCapabilityBatchExecution?.invocations.reduce(
      (total, invocation) => total + invocation.guidance.length,
      0,
    ) ?? 0
  );
}
