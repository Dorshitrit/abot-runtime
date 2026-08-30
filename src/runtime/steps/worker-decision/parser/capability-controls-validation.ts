import type { WorkerDecisionValidationIssue } from "../contracts.js";
import {
  mergeWorkerCapabilityControls,
  partitionWorkerCapabilityControlsSchema,
  validateWorkerCapabilityRemainingControls,
  validateWorkerCapabilitySelectionControls,
  type WorkerCapabilityControls,
  type WorkerCapabilityControlsPartition,
  type WorkerCapabilityControlsSchema,
  type WorkerCapabilityDescriptor,
} from "../../../orchestration/worker-capabilities/index.js";
import { readWorkerDecisionRecord } from "./decision-shape-validation.js";
import type { CapabilityInvocationValidationInput } from "./validation-contract.js";
import {
  createWorkerDecisionIssue,
  hasObservationOnlyCapabilityMismatch,
} from "./validation-contract.js";

export function partitionSelectedCapabilityControls(
  selectedCapability: WorkerCapabilityDescriptor | undefined,
  capabilityPath: string,
  issues: WorkerDecisionValidationIssue[],
): WorkerCapabilityControlsPartition | undefined {
  if (!selectedCapability) return undefined;
  const partition = partitionWorkerCapabilityControlsSchema(
    selectedCapability.controls,
    selectedCapability.selectionControlIds,
  );
  if (partition.ok) return partition.value;
  issues.push(
    createWorkerDecisionIssue(
      "worker_capability_controls_schema_invalid",
      capabilityPath,
    ),
  );
  return undefined;
}

export function validateCapabilitySelectionControls(
  params: CapabilityInvocationValidationInput,
  selectedCapability: WorkerCapabilityDescriptor | undefined,
  controlsPartition: WorkerCapabilityControlsPartition | undefined,
  issues: WorkerDecisionValidationIssue[],
): WorkerCapabilityControls | undefined {
  if (!selectedCapability) return undefined;
  if (hasObservationOnlyCapabilityMismatch(params, selectedCapability)) {
    return undefined;
  }
  if (!controlsPartition) return undefined;
  if (params.decisionPhase !== "capability_selection") return undefined;
  if (controlsPartition.selectionControlIds.length === 0) return undefined;
  const selectionControls = validateWorkerCapabilitySelectionControls(
    controlsPartition,
    normalizeGeneratedCapabilityControls(
      params.record.selectionControls,
      controlsPartition.selectionSchema,
    ),
  );
  if (selectionControls.ok) return selectionControls.value;
  issues.push(
    createWorkerCapabilityControlsIssue({
      issueCode: selectionControls.issueCode,
      controlId: selectionControls.controlId,
      path: selectionControls.controlId
        ? `${params.path}.selectionControls.${selectionControls.controlId}`
        : `${params.path}.selectionControls`,
      capability: selectedCapability,
      schema: controlsPartition.selectionSchema,
      pendingSlotId: params.pendingSlotId,
    }),
  );
  return undefined;
}

export function validateCapabilityExecutionControls(
  params: CapabilityInvocationValidationInput,
  selectedCapability: WorkerCapabilityDescriptor | undefined,
  controlsPartition: WorkerCapabilityControlsPartition | undefined,
  issues: WorkerDecisionValidationIssue[],
): WorkerCapabilityControls | undefined {
  if (!selectedCapability) {
    reportNonObjectExecutionControls(params, issues);
    return undefined;
  }
  if (hasObservationOnlyCapabilityMismatch(params, selectedCapability)) {
    reportNonObjectExecutionControls(params, issues);
    return undefined;
  }
  if (!controlsPartition) {
    reportNonObjectExecutionControls(params, issues);
    return undefined;
  }
  if (params.decisionPhase !== "capability_execution") {
    reportNonObjectExecutionControls(params, issues);
    return undefined;
  }
  const remainingControls = validateWorkerCapabilityRemainingControls(
    controlsPartition,
    normalizeGeneratedCapabilityControls(
      params.record.controls,
      controlsPartition.remainingSchema,
    ),
  );
  if (!remainingControls.ok) {
    issues.push(
      createWorkerCapabilityControlsIssue({
        issueCode: remainingControls.issueCode,
        controlId: remainingControls.controlId,
        path: remainingControls.controlId
          ? `${params.path}.controls.${remainingControls.controlId}`
          : `${params.path}.controls`,
        capability: selectedCapability,
        schema: controlsPartition.remainingSchema,
        pendingSlotId: params.pendingSlotId,
      }),
    );
    return undefined;
  }
  const mergedControls = mergeWorkerCapabilityControls(controlsPartition, {
    selectionControls: params.pendingInvocation?.selectionControls ?? {},
    remainingControls: remainingControls.value,
  });
  if (mergedControls.ok) return mergedControls.value;
  issues.push(
    createWorkerCapabilityControlsIssue({
      issueCode: mergedControls.issueCode,
      controlId: mergedControls.controlId,
      path: mergedControls.controlId
        ? `${params.path}.controls.${mergedControls.controlId}`
        : `${params.path}.controls`,
      capability: selectedCapability,
      schema: controlsPartition.remainingSchema,
      pendingSlotId: params.pendingSlotId,
    }),
  );
  return undefined;
}

function reportNonObjectExecutionControls(
  params: CapabilityInvocationValidationInput,
  issues: WorkerDecisionValidationIssue[],
): void {
  if (params.decisionPhase !== "capability_execution") return;
  if (readWorkerDecisionRecord(params.record.controls)) return;
  issues.push(
    createWorkerDecisionIssue(
      "worker_capability_controls_not_object",
      `${params.path}.controls`,
    ),
  );
}

function normalizeGeneratedCapabilityControls(
  value: unknown,
  schema: WorkerCapabilityControlsSchema,
): unknown {
  const record = readWorkerDecisionRecord(value);
  if (!record) return value;
  const required = new Set(schema.required);
  return Object.fromEntries(
    Object.entries(record).filter(([controlId, controlValue]) =>
      shouldRetainGeneratedCapabilityControl(
        controlId,
        controlValue,
        required,
        schema,
      ),
    ),
  );
}

function shouldRetainGeneratedCapabilityControl(
  controlId: string,
  controlValue: unknown,
  required: ReadonlySet<string>,
  schema: WorkerCapabilityControlsSchema,
): boolean {
  if (controlValue !== null) return true;
  if (required.has(controlId)) return true;
  return !Object.prototype.hasOwnProperty.call(schema.properties, controlId);
}

function createWorkerCapabilityControlsIssue(
  params: Readonly<{
    issueCode: string;
    controlId: string | undefined;
    path: string;
    capability: WorkerCapabilityDescriptor;
    schema: WorkerCapabilityControlsSchema;
    pendingSlotId: string | undefined;
  }>,
): WorkerDecisionValidationIssue {
  const code = `worker_capability_${params.issueCode}`;
  if (!requiresDetailedCapabilityControlsIssue(params.issueCode)) {
    return createWorkerDecisionIssue(code, params.path);
  }
  return createWorkerDecisionIssue(
    code,
    params.path,
    `${pendingCapabilityBindingMessage(params)} ${capabilityControlProblemMessage(params)} Allowed control IDs: ${JSON.stringify(Object.keys(params.schema.properties))}. Required control IDs: ${JSON.stringify(params.schema.required)}.`,
  );
}

function requiresDetailedCapabilityControlsIssue(issueCode: string): boolean {
  return (
    issueCode === "controls_unknown" ||
    issueCode === "controls_required_missing"
  );
}

function pendingCapabilityBindingMessage(
  params: Readonly<{
    pendingSlotId: string | undefined;
    capability: WorkerCapabilityDescriptor;
  }>,
): string {
  if (params.pendingSlotId) {
    return `Pending slot ${JSON.stringify(params.pendingSlotId)} is frozen to capabilityId ${JSON.stringify(params.capability.capabilityId)}.`;
  }
  return `Pending capabilityId is ${JSON.stringify(params.capability.capabilityId)}.`;
}

function capabilityControlProblemMessage(
  params: Readonly<{ issueCode: string; controlId: string | undefined }>,
): string {
  if (params.issueCode === "controls_unknown") {
    return `Control ${JSON.stringify(params.controlId)} is not allowed for this capability.`;
  }
  return `Required control ${JSON.stringify(params.controlId)} is missing for this capability.`;
}
