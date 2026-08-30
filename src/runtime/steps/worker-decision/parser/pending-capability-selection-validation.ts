import { WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH } from "../contracts.js";
import { WORKER_CAPABILITY_INTENT_MAX_LENGTH } from "../contracts.js";
import {
  partitionWorkerCapabilityControlsSchema,
  validateWorkerCapabilitySelectionControls,
  type WorkerCapabilityDescriptor,
} from "../../../orchestration/worker-capabilities/index.js";
import type {
  DecisionValidationContext,
  PendingCapabilityInvocation,
} from "./validation-contract.js";

type PendingSelectionValidationOptions = Pick<
  DecisionValidationContext,
  | "decisionPhase"
  | "pendingCapabilitySelection"
  | "pendingCapabilityBatchSelection"
  | "availableCapabilities"
  | "maxBatchCapabilityExecutions"
>;

export function validatePendingSelectionOptions(
  options: PendingSelectionValidationOptions,
): void {
  if (options.decisionPhase === "capability_selection") {
    rejectUnexpectedPendingCapabilitySelection(options);
    return;
  }
  if (!hasExactlyOnePendingCapabilitySelection(options)) {
    throw new Error("worker_pending_capability_selection_invalid");
  }
  if (options.pendingCapabilitySelection) {
    validatePendingSingleCapabilitySelection(options);
    return;
  }
  if (!hasValidPendingCapabilityBatchSelection(options)) {
    throw new Error("worker_pending_capability_batch_selection_invalid");
  }
}

function rejectUnexpectedPendingCapabilitySelection(
  options: PendingSelectionValidationOptions,
): void {
  if (!hasUnexpectedPendingCapabilitySelection(options)) return;
  throw new Error("worker_pending_capability_selection_unexpected");
}

function hasUnexpectedPendingCapabilitySelection(
  options: PendingSelectionValidationOptions,
): boolean {
  if (options.pendingCapabilitySelection !== undefined) return true;
  return options.pendingCapabilityBatchSelection !== undefined;
}

function hasExactlyOnePendingCapabilitySelection(
  options: PendingSelectionValidationOptions,
): boolean {
  const hasSingle = options.pendingCapabilitySelection !== undefined;
  const hasBatch = options.pendingCapabilityBatchSelection !== undefined;
  return hasSingle !== hasBatch;
}

function validatePendingSingleCapabilitySelection(
  options: PendingSelectionValidationOptions,
): void {
  const pending = options.pendingCapabilitySelection!;
  const descriptor = options.availableCapabilities.find(
    ({ capabilityId }) => capabilityId === pending.capabilityId,
  );
  if (isValidPendingSingleSelection(pending, descriptor)) return;
  throw new Error("worker_pending_capability_selection_invalid");
}

function isValidPendingSingleSelection(
  pending: PendingCapabilityInvocation,
  descriptor: WorkerCapabilityDescriptor | undefined,
): boolean {
  if (!descriptor) return false;
  if (!hasValidPendingCapabilityIntent(pending)) return false;
  if (!hasExpectedPendingSelectionControls(pending, descriptor)) return false;
  return hasExpectedPendingAuthoringObjective(pending, descriptor);
}

function hasValidPendingCapabilityBatchSelection(
  options: PendingSelectionValidationOptions,
): boolean {
  const pendingBatch = options.pendingCapabilityBatchSelection;
  if (!Array.isArray(pendingBatch)) return false;
  if (pendingBatch.length < 2) return false;
  if (!Number.isInteger(options.maxBatchCapabilityExecutions)) return false;
  if (pendingBatch.length > options.maxBatchCapabilityExecutions) return false;
  return pendingBatch.every((pending) =>
    isValidPendingObservationBatchItem(pending, options.availableCapabilities),
  );
}

function isValidPendingObservationBatchItem(
  pending: PendingCapabilityInvocation,
  availableCapabilities: readonly WorkerCapabilityDescriptor[],
): boolean {
  const descriptor = availableCapabilities.find(
    ({ capabilityId }) => capabilityId === pending.capabilityId,
  );
  if (!descriptor) return false;
  if (descriptor.effect !== "observation") return false;
  if (!hasValidPendingCapabilityIntent(pending)) return false;
  if (!hasExpectedPendingSelectionControls(pending, descriptor)) return false;
  return hasExpectedPendingAuthoringObjective(pending, descriptor);
}

function hasValidPendingCapabilityIntent(
  pending: PendingCapabilityInvocation,
): boolean {
  if (pending.intent.trim() !== pending.intent) return false;
  if (pending.intent.length === 0) return false;
  return pending.intent.length <= WORKER_CAPABILITY_INTENT_MAX_LENGTH;
}

function hasExpectedPendingAuthoringObjective(
  pending: PendingCapabilityInvocation,
  descriptor: WorkerCapabilityDescriptor,
): boolean {
  const required = descriptor.requiresPayloadAuthoringObjective === true;
  if (Object.hasOwn(pending, "authoringObjective") !== required) return false;
  if (!required) return true;
  const value = pending.authoringObjective;
  if (typeof value !== "string") return false;
  if (value.trim() !== value) return false;
  if (value.length === 0) return false;
  return value.length <= WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH;
}

function hasExpectedPendingSelectionControls(
  pending: PendingCapabilityInvocation,
  descriptor: WorkerCapabilityDescriptor,
): boolean {
  const partition = partitionWorkerCapabilityControlsSchema(
    descriptor.controls,
    descriptor.selectionControlIds,
  );
  if (!partition.ok) return false;
  const expected = partition.value.selectionControlIds.length > 0;
  if (Object.hasOwn(pending, "selectionControls") !== expected) return false;
  return validateWorkerCapabilitySelectionControls(
    partition.value,
    pending.selectionControls ?? {},
  ).ok;
}
