import { isRoleCapabilityId } from "../../../orchestration/role-calls/index.js";
import {
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  partitionWorkerCapabilityControlsSchema,
  validateWorkerCapabilitySelectionControls,
  type WorkerCapabilityDescriptor,
} from "../../../orchestration/worker-capabilities/index.js";
import type {
  PreparedWorkerCapabilitySelection,
  WorkerDecisionCapabilityResumeSource,
  WorkerDecisionCapabilitySource,
  WorkerDecisionInputOptions,
  WorkerPendingCapabilitySelection,
  WorkerSelectedCapabilityBatchExecution,
  WorkerSelectedCapabilityExecution,
} from "./types.js";

export function prepareWorkerCapabilitySelection(
  options: WorkerDecisionInputOptions,
  projectedCapabilities: readonly WorkerCapabilityDescriptor[],
): PreparedWorkerCapabilitySelection {
  const selectedCapabilityExecution = options.selectedCapabilityExecution
    ? normalizeSelectedCapabilityExecution(
        options.selectedCapabilityExecution,
        projectedCapabilities,
      )
    : undefined;
  const selectedCapabilityBatchExecution =
    options.selectedCapabilityBatchExecution
      ? normalizeSelectedCapabilityBatchExecution(
          options.selectedCapabilityBatchExecution,
          projectedCapabilities,
        )
      : undefined;

  if (selectedCapabilityExecution && selectedCapabilityBatchExecution) {
    throw new Error("worker_selected_capability_execution_ambiguous");
  }

  const pendingCapabilitySelection = selectedCapabilityExecution
    ? projectPendingCapabilitySelection(selectedCapabilityExecution)
    : undefined;
  const pendingCapabilityBatchSelection = selectedCapabilityBatchExecution
    ? Object.freeze(
        selectedCapabilityBatchExecution.invocations.map(
          projectPendingCapabilitySelection,
        ),
      )
    : undefined;

  return Object.freeze({
    capabilities: selectExecutionCapabilities(
      projectedCapabilities,
      selectedCapabilityExecution,
      selectedCapabilityBatchExecution,
    ),
    ...(selectedCapabilityExecution ? { selectedCapabilityExecution } : {}),
    ...(selectedCapabilityBatchExecution
      ? { selectedCapabilityBatchExecution }
      : {}),
    ...(pendingCapabilitySelection ? { pendingCapabilitySelection } : {}),
    ...(pendingCapabilityBatchSelection
      ? { pendingCapabilityBatchSelection }
      : {}),
    executionPending:
      selectedCapabilityExecution !== undefined ||
      selectedCapabilityBatchExecution !== undefined,
  });
}

function projectPendingCapabilitySelection(
  selection: WorkerPendingCapabilitySelection,
): WorkerPendingCapabilitySelection {
  return Object.freeze({
    capabilityId: selection.capabilityId,
    intent: selection.intent,
    ...(selection.selectionControls
      ? { selectionControls: selection.selectionControls }
      : {}),
  });
}

function selectExecutionCapabilities(
  projectedCapabilities: readonly WorkerCapabilityDescriptor[],
  selectedCapabilityExecution: WorkerSelectedCapabilityExecution | undefined,
  selectedCapabilityBatchExecution:
    | WorkerSelectedCapabilityBatchExecution
    | undefined,
): readonly WorkerCapabilityDescriptor[] {
  if (selectedCapabilityExecution) {
    return Object.freeze(
      projectedCapabilities.filter(
        ({ capabilityId }) =>
          capabilityId === selectedCapabilityExecution.capabilityId,
      ),
    );
  }
  if (!selectedCapabilityBatchExecution) return projectedCapabilities;

  const selectedCapabilityIds = new Set(
    selectedCapabilityBatchExecution.invocations.map(
      ({ capabilityId }) => capabilityId,
    ),
  );
  return Object.freeze(
    projectedCapabilities.filter(({ capabilityId }) =>
      selectedCapabilityIds.has(capabilityId),
    ),
  );
}

function normalizeSelectedCapabilityExecution(
  input: WorkerSelectedCapabilityExecution,
  capabilities: readonly WorkerCapabilityDescriptor[],
): WorkerSelectedCapabilityExecution {
  const descriptor = capabilities.find(
    ({ capabilityId }) => capabilityId === input?.capabilityId,
  );
  if (
    typeof input !== "object" ||
    input === null ||
    !isRoleCapabilityId(input.capabilityId) ||
    typeof input.intent !== "string" ||
    input.intent.trim().length === 0 ||
    input.intent.trim().length > WORKER_CAPABILITY_INTENT_MAX_LENGTH ||
    typeof input.guidance !== "string" ||
    !descriptor
  ) {
    throw new Error("worker_selected_capability_execution_invalid");
  }
  const controlsPartition = partitionWorkerCapabilityControlsSchema(
    descriptor.controls,
    descriptor.selectionControlIds,
  );
  const hasSelectionControls = Object.hasOwn(input, "selectionControls");
  const selectionControls = controlsPartition.ok
    ? validateWorkerCapabilitySelectionControls(
        controlsPartition.value,
        input.selectionControls ?? {},
      )
    : controlsPartition;
  if (
    !controlsPartition.ok ||
    !selectionControls.ok ||
    hasSelectionControls !==
      controlsPartition.value.selectionControlIds.length > 0
  ) {
    throw new Error("worker_selected_capability_execution_invalid");
  }
  return Object.freeze({
    capabilityId: input.capabilityId,
    intent: input.intent.trim(),
    ...(controlsPartition.value.selectionControlIds.length > 0
      ? { selectionControls: selectionControls.value }
      : {}),
    guidance: input.guidance.trim(),
  });
}

function normalizeSelectedCapabilityBatchExecution(
  input: WorkerSelectedCapabilityBatchExecution,
  capabilities: readonly WorkerCapabilityDescriptor[],
): WorkerSelectedCapabilityBatchExecution {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray(input.invocations) ||
    input.invocations.length < 2
  ) {
    throw new Error("worker_selected_capability_batch_execution_invalid");
  }
  const invocations = input.invocations.map((invocation) => {
    const descriptor = capabilities.find(
      ({ capabilityId }) => capabilityId === invocation?.capabilityId,
    );
    if (
      typeof invocation !== "object" ||
      invocation === null ||
      !descriptor ||
      descriptor.effect !== "observation" ||
      typeof invocation.intent !== "string" ||
      invocation.intent.trim().length === 0 ||
      invocation.intent.length > WORKER_CAPABILITY_INTENT_MAX_LENGTH ||
      typeof invocation.guidance !== "string"
    ) {
      throw new Error("worker_selected_capability_batch_execution_invalid");
    }
    const controlsPartition = partitionWorkerCapabilityControlsSchema(
      descriptor.controls,
      descriptor.selectionControlIds,
    );
    const hasSelectionControls = Object.hasOwn(invocation, "selectionControls");
    const selectionControls = controlsPartition.ok
      ? validateWorkerCapabilitySelectionControls(
          controlsPartition.value,
          invocation.selectionControls ?? {},
        )
      : controlsPartition;
    if (
      !controlsPartition.ok ||
      !selectionControls.ok ||
      hasSelectionControls !==
        controlsPartition.value.selectionControlIds.length > 0
    ) {
      throw new Error("worker_selected_capability_batch_execution_invalid");
    }
    return Object.freeze({
      capabilityId: descriptor.capabilityId,
      intent: invocation.intent.trim(),
      ...(controlsPartition.value.selectionControlIds.length > 0
        ? { selectionControls: selectionControls.value }
        : {}),
      guidance: invocation.guidance.trim(),
    });
  });
  return Object.freeze({ invocations: Object.freeze(invocations) });
}

export function canOfferCapabilityBatch(params: {
  capabilities: readonly WorkerCapabilityDescriptor[];
  canonicalSource:
    | WorkerDecisionCapabilitySource
    | WorkerDecisionCapabilityResumeSource
    | undefined;
  selectedCapabilityBatchExecution:
    | WorkerSelectedCapabilityBatchExecution
    | undefined;
  selectedCapabilityExecution: WorkerSelectedCapabilityExecution | undefined;
}): boolean {
  if (params.selectedCapabilityBatchExecution) return true;
  if (params.selectedCapabilityExecution) return false;
  if (!params.canonicalSource) return false;
  const remaining =
    params.canonicalSource.head.policy.limits.maxCapabilityExecutions -
    params.canonicalSource.head.state.capabilityExecutions.length;
  return (
    remaining >= 2 &&
    params.capabilities.some(({ effect }) => effect === "observation")
  );
}
