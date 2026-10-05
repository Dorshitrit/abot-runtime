import {
  CAPABILITY_INTENT_MAX_LENGTH,
  type CapabilityControl,
  type CapabilityControlsSchema,
} from "../../orchestration/capability-adapters/index.js";
import {
  executionOperationObjectiveSchema,
  requiresExecutionOperationObjective,
} from "./capability-invocation-contract.js";
import {
  controlsEvidenceSelectionSchema,
  requiresControlsEvidenceSelection,
} from "./controls-evidence-contract.js";
import type { PreparedExecutionAgentCapability } from "./format.js";

/** Groups only capabilities whose complete model-facing invocation shapes agree. */
export function projectCapabilitySelectionProperties(
  capabilities: readonly PreparedExecutionAgentCapability[],
  eligibleEvidence: readonly string[],
): readonly Readonly<Record<string, unknown>>[] {
  const groups = new Map<string, PreparedExecutionAgentCapability[]>();
  for (const capability of capabilities) {
    const signature = JSON.stringify([
      capability.partition.selectionSchema,
      requiresExecutionOperationObjective(
        capability.partition,
        capability.requiresPayloadAuthoringObjective,
      ),
      requiresControlsEvidenceSelection(capability.partition),
    ]);
    const group = groups.get(signature) ?? [];
    group.push(capability);
    groups.set(signature, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) => {
      const representative = group[0]!;
      const partition = representative.partition;
      return Object.freeze({
        capabilityId: {
          type: "string",
          enum: group.map(({ capabilityId }) => capabilityId),
        },
        intent: {
          type: "string",
          minLength: 1,
          maxLength: CAPABILITY_INTENT_MAX_LENGTH,
        },
        ...(requiresExecutionOperationObjective(
          partition,
          representative.requiresPayloadAuthoringObjective,
        )
          ? { operationObjective: executionOperationObjectiveSchema() }
          : {}),
        ...(requiresControlsEvidenceSelection(partition)
          ? {
              controlsEvidenceExecutionIds:
                controlsEvidenceSelectionSchema(eligibleEvidence),
            }
          : {}),
        ...(partition.selectionControlIds.length > 0
          ? {
              selectionControls: projectControlsSchema(
                partition.selectionSchema,
              ),
            }
          : {}),
      });
    }),
  );
}

function projectControlsSchema(
  schema: CapabilityControlsSchema,
): Record<string, unknown> {
  const required = new Set(schema.required);
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([controlId, control]) => [
      controlId,
      required.has(controlId)
        ? projectControlSchema(control)
        : { anyOf: [projectControlSchema(control), { type: "null" }] },
    ]),
  );
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function projectControlSchema(
  control: CapabilityControl,
): Record<string, unknown> {
  if (control.type === "array")
    return {
      type: "array",
      items: projectControlSchema(control.items),
      minItems: control.minItems,
      maxItems: control.maxItems,
    };
  if (control.type === "string" && "enum" in control)
    return { type: "string", enum: [...control.enum] };
  return { ...control };
}
