import {
  EMPTY_CAPABILITY_CONTROLS_SCHEMA,
  partitionCapabilityControlsSchema,
  type CapabilityControlsPartitionResult,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";

/** The evidence-owning EA selects the complete operation for ordinary observations. */
export function ownsExecutionObservationControls(
  descriptor: CapabilityDescriptor,
): boolean {
  if (descriptor.effect !== "observation") return false;
  return descriptor.requiresPayloadAuthoringObjective !== true;
}

/**
 * This is an EA model-facing projection, not a change to the shared descriptor.
 * Optional controls remain optional: a generated null is an intentional omission,
 * normalized by the decision parser before execution, never a later choice.
 */
export function partitionExecutionCapabilityControls(
  descriptor: CapabilityDescriptor,
): CapabilityControlsPartitionResult {
  const partition = partitionCapabilityControlsSchema(
    descriptor.controls,
    descriptor.selectionControlIds,
  );
  if (!partition.ok) return partition;
  if (!ownsExecutionObservationControls(descriptor)) return partition;
  const fullSchema = partition.value.fullSchema;
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      fullSchema,
      selectionSchema: fullSchema,
      remainingSchema: EMPTY_CAPABILITY_CONTROLS_SCHEMA,
      selectionControlIds: Object.freeze(Object.keys(fullSchema.properties)),
    }),
  });
}
