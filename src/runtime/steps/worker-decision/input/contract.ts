import type { WorkerCapabilityDescriptor } from "../../../orchestration/worker-capabilities/index.js";
import { projectWorkerCapabilityAffordances } from "../capability-affordances.js";
import { projectWorkerCapabilitySelectionCatalog } from "../capability-catalog.js";
import { normalizeWorkerCapabilitySelectionRejection } from "../capability-selection-rejection.js";
import { WORKER_DECISION_ACTIONS } from "../contracts.js";
import { createWorkerDecisionFormat } from "../format.js";
import { resolveWorkerDecisionAllowedActions } from "./action-policy.js";
import { canOfferCapabilityBatch } from "./capability-selection.js";
import type {
  PreparedWorkerCapabilitySelection,
  PreparedWorkerDecisionContract,
  WorkerDecisionCapabilityResumeSource,
  WorkerDecisionCapabilitySource,
  WorkerDecisionInputOptions,
  WorkerSelectedCapabilityBatchExecution,
  WorkerSelectedCapabilityExecution,
} from "./types.js";

export function prepareWorkerDecisionContract(
  params: Readonly<{
    options: WorkerDecisionInputOptions;
    projectedCapabilities: readonly WorkerCapabilityDescriptor[];
    eligibleSessionArtifactPaths: readonly string[];
    canonicalSource:
      | WorkerDecisionCapabilitySource
      | WorkerDecisionCapabilityResumeSource
      | undefined;
    dependencyResultCount: number;
    capabilitySelection: PreparedWorkerCapabilitySelection;
  }>,
): PreparedWorkerDecisionContract {
  const {
    capabilities,
    selectedCapabilityExecution,
    selectedCapabilityBatchExecution,
    pendingCapabilitySelection,
    pendingCapabilityBatchSelection,
    executionPending: capabilityExecutionPending,
  } = params.capabilitySelection;
  const availableCapabilityIds = Object.freeze(
    capabilities.map((descriptor) => descriptor.capabilityId),
  );
  const availableCapabilityAffordances =
    projectWorkerCapabilityAffordances(capabilities);
  const capabilitiesAvailable = capabilities.length > 0;
  const sessionArtifactPathSelectionDeferred =
    !capabilityExecutionPending &&
    params.eligibleSessionArtifactPaths.length > 0 &&
    runtimePathSelectionWasDeferred(
      params.options.capabilitySource?.binding.capabilities,
      params.projectedCapabilities,
    );
  const capabilitySelectionRejectionPresent =
    params.options.capabilitySelectionRejection !== undefined;
  const capabilitySelectionRejection =
    !capabilityExecutionPending && params.options.capabilitySelectionRejection
      ? normalizeWorkerCapabilitySelectionRejection(
          params.options.capabilitySelectionRejection,
          params.projectedCapabilities.map(({ capabilityId }) => capabilityId),
        )
      : undefined;
  const selectionCatalog =
    projectWorkerCapabilitySelectionCatalog(capabilities);
  const capabilityCatalogProjection = capabilityExecutionPending
    ? ("flat" as const)
    : selectionCatalog.kind;
  const capabilityPromptPayload = capabilityExecutionPending
    ? Object.freeze({ availableCapabilities: availableCapabilityAffordances })
    : selectionCatalog.promptPayload;
  const canInvokeSingleCapability =
    capabilitiesAvailable && !selectedCapabilityBatchExecution;
  const canInvokeCapabilityBatch = canOfferCapabilityBatch({
    capabilities,
    canonicalSource: params.canonicalSource,
    selectedCapabilityExecution,
    selectedCapabilityBatchExecution,
  });
  const allowedActions = resolveWorkerDecisionAllowedActions({
    capabilityExecutionPending,
    capabilitySelectionRejectionPresent,
    dependencyResultCount: params.dependencyResultCount,
    requestToolResultCount: params.options.requestToolResults.results.length,
    canInvokeSingleCapability,
    canInvokeCapabilityBatch,
  });
  const remainingCapabilityExecutions = params.canonicalSource
    ? params.canonicalSource.head.policy.limits.maxCapabilityExecutions -
      params.canonicalSource.head.state.capabilityExecutions.length
    : 0;
  const maxBatchCapabilityExecutions = resolveMaxBatchCapabilityExecutions({
    selectedCapabilityExecution,
    selectedCapabilityBatchExecution,
    remainingCapabilityExecutions,
  });
  const format = createWorkerDecisionFormat({
    capabilities,
    maxBatchCapabilityExecutions,
    allowSingleCapabilityInvocation: !selectedCapabilityBatchExecution,
    allowReturnResult: allowedActions.includes(WORKER_DECISION_ACTIONS[0]),
    allowReturnFailure: allowedActions.includes(WORKER_DECISION_ACTIONS[1]),
    ...(pendingCapabilitySelection ? { pendingCapabilitySelection } : {}),
    ...(pendingCapabilityBatchSelection
      ? {
          pendingCapabilityBatchSelection,
        }
      : {}),
  });

  return Object.freeze({
    availableCapabilityIds,
    availableCapabilityAffordances,
    capabilitiesAvailable,
    sessionArtifactPathSelectionDeferred,
    capabilitySelectionRejection,
    selectionCatalog,
    capabilityCatalogProjection,
    capabilityPromptPayload,
    allowedActions,
    maxBatchCapabilityExecutions,
    format,
  });
}

function resolveMaxBatchCapabilityExecutions(
  params: Readonly<{
    selectedCapabilityExecution?: WorkerSelectedCapabilityExecution;
    selectedCapabilityBatchExecution?: WorkerSelectedCapabilityBatchExecution;
    remainingCapabilityExecutions: number;
  }>,
): number {
  if (params.selectedCapabilityExecution) return 0;
  if (params.selectedCapabilityBatchExecution) {
    return params.selectedCapabilityBatchExecution.invocations.length;
  }
  return Math.max(0, params.remainingCapabilityExecutions);
}

function runtimePathSelectionWasDeferred(
  sourceCapabilities: readonly WorkerCapabilityDescriptor[] | undefined,
  effectiveCapabilities: readonly WorkerCapabilityDescriptor[],
): boolean {
  if (!sourceCapabilities) return false;
  return sourceCapabilities.some((source) => {
    const effective = effectiveCapabilities.find(
      ({ capabilityId }) => capabilityId === source.capabilityId,
    );
    if (!effective) return false;
    const effectiveSelectionControlIds = new Set(
      effective.selectionControlIds ?? [],
    );
    const runtimePathControlIds = new Set(source.runtimePathControlIds ?? []);
    return (source.selectionControlIds ?? []).some(
      (controlId) =>
        runtimePathControlIds.has(controlId) &&
        !effectiveSelectionControlIds.has(controlId),
    );
  });
}
