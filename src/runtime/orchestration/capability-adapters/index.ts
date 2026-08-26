/**
 * Policy-neutral capability vocabulary over the single role-call capability
 * implementation. This module deliberately contains no binding or execution
 * engine; it only gives root contracts neutral names for shared contracts.
 */
export {
  WORKER_CAPABILITY_CONTROL_ARRAY_MAX_ITEMS as CAPABILITY_CONTROL_ARRAY_MAX_ITEMS,
  WORKER_CAPABILITY_CONTROL_COUNT_MAX as CAPABILITY_CONTROL_COUNT_MAX,
  WORKER_CAPABILITY_CONTROL_ENUM_MAX_VALUES as CAPABILITY_CONTROL_ENUM_MAX_VALUES,
  WORKER_CAPABILITY_CONTROL_ENUM_VALUE_MAX_LENGTH as CAPABILITY_CONTROL_ENUM_VALUE_MAX_LENGTH,
  WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH as CAPABILITY_CONTROL_ID_MAX_LENGTH,
  WORKER_CAPABILITY_CONTROL_STRING_MAX_LENGTH as CAPABILITY_CONTROL_STRING_MAX_LENGTH,
  WORKER_CAPABILITY_COUNT_MAX as CAPABILITY_COUNT_MAX,
  WORKER_CAPABILITY_ID_MAX_LENGTH as CAPABILITY_ID_MAX_LENGTH,
  WORKER_CAPABILITY_INTENT_MAX_LENGTH as CAPABILITY_INTENT_MAX_LENGTH,
  WORKER_CAPABILITY_SUMMARY_MAX_LENGTH as CAPABILITY_SUMMARY_MAX_LENGTH,
  EMPTY_WORKER_CAPABILITY_CONTROLS_SCHEMA as EMPTY_CAPABILITY_CONTROLS_SCHEMA,
} from "../worker-capabilities/contracts.js";

export type {
  WorkerCapabilityArrayControl as CapabilityArrayControl,
  WorkerCapabilityBooleanControl as CapabilityBooleanControl,
  WorkerCapabilityBoundedStringControl as CapabilityBoundedStringControl,
  WorkerCapabilityControl as CapabilityControl,
  WorkerCapabilityControls as CapabilityControls,
  WorkerCapabilityControlsSchema as CapabilityControlsSchema,
  WorkerCapabilityDescriptor as CapabilityDescriptor,
  WorkerCapabilityEffect as CapabilityDeclaredEffect,
  WorkerCapabilityEnumControl as CapabilityEnumControl,
  WorkerCapabilityNumberControl as CapabilityNumberControl,
  WorkerCapabilityScalarControl as CapabilityScalarControl,
  WorkerCapabilityUnboundedStringControl as CapabilityUnboundedStringControl,
} from "../worker-capabilities/contracts.js";

export {
  normalizeWorkerCapabilityControlsSchema as normalizeCapabilityControlsSchema,
  validateWorkerCapabilityControls as validateCapabilityControls,
} from "../worker-capabilities/controls.js";

export {
  materializeWorkerCapabilityControlsIfComplete as materializeCapabilityControlsIfComplete,
  mergeWorkerCapabilityControls as mergeCapabilityControls,
  normalizeWorkerCapabilitySelectionControlIds as normalizeCapabilitySelectionControlIds,
  partitionWorkerCapabilityControlsSchema as partitionCapabilityControlsSchema,
  validateWorkerCapabilityRemainingControls as validateCapabilityRemainingControls,
  validateWorkerCapabilitySelectionControls as validateCapabilitySelectionControls,
} from "../worker-capabilities/selection-controls.js";

export type {
  WorkerCapabilityControlsPartition as CapabilityControlsPartition,
  WorkerCapabilityControlsPartitionResult as CapabilityControlsPartitionResult,
  WorkerCapabilitySelectionControlIdsNormalization as CapabilitySelectionControlIdsNormalization,
} from "../worker-capabilities/selection-controls.js";

export {
  CAPABILITY_CATALOG_GROUP_COUNT_MAX,
  projectCapabilityCatalogGroups,
  projectCapabilityScope,
  type CapabilityCatalogGroup,
} from "./scope.js";
export { normalizeCapabilityDescriptor } from "./descriptor.js";
export {
  CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES,
  captureLegacyCapabilityAdapterResult,
  normalizeCapabilityAdapterResult,
  type CanonicalToolExecutionResult,
  type CapabilityAdapterResult,
  type CapabilityAdapterResultNormalization,
  type CapabilityJsonObject,
  type CapabilityJsonPrimitive,
  type CapabilityJsonValue,
  type CapabilityResultReference,
  type GenericCapabilityAdapterResult,
  type RegisteredToolCapabilityResult,
  type RuntimeCapabilityRejectionResult,
} from "./result.js";
export {
  EXECUTION_WORKING_DIRECTORY_MAX_LENGTH,
  EXECUTION_WORKING_DIRECTORY_PATTERN,
  normalizeExecutionWorkingDirectory,
} from "./working-directory.js";
