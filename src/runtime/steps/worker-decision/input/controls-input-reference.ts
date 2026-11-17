import type {
  WorkerCapabilityControlsSchema,
  WorkerCapabilityDescriptor,
} from "../../../orchestration/worker-capabilities/contracts.js";

const CONTROLS_INPUT_REFERENCE = Object.freeze({
  kind: "runtime_capability_controls_input_reference_v1",
  authority: "selected_capability_input_contract",
  provenance: "bound_capability_descriptor",
  purpose: "Describe the remaining arguments for this selected invocation only.",
  required: "remainingControls.required identifies arguments required by the capability.",
  responseKeys: "Include every remaining control key required by the response schema. Use null for an unset optional argument; the Runtime omits it before execution. Required arguments cannot be null.",
  examples: "Examples illustrate field usage only. They are not defaults, requested values, or prescribed answers.",
  presenceEffect: "Adds no user intent, capability choice, permission, or completion evidence. The enclosing assignment remains authoritative.",
  completeness: "All remaining fields are included without truncation. Missing descriptions or examples mean the capability did not declare them.",
});

/** Request-local documentation; never an execution schema or saved evidence. */
export function projectCapabilityControlsInputReference(
  remainingSchema: WorkerCapabilityControlsSchema,
  documentation: WorkerCapabilityDescriptor["controlDocumentation"],
) {
  const properties = Object.freeze(Object.fromEntries(
    Object.entries(remainingSchema.properties).map(([name, schema]) => [
      name,
      Object.freeze({ ...schema, ...documentation?.[name] }),
    ]),
  ));
  return Object.freeze({
    remainingControls: Object.freeze({ ...remainingSchema, properties }),
    controlsReference: CONTROLS_INPUT_REFERENCE,
  });
}
