import { projectStrictControlsSchema } from "../../model/decision-schema.js";
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
              selectionControls: projectStrictControlsSchema(
                partition.selectionSchema,
              ),
            }
          : {}),
      });
    }),
  );
}
