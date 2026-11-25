import { ROLE_CAPABILITY_EXECUTION_LIMIT_MAX } from "../../orchestration/role-calls/contracts.js";
import { MODEL_WORK_PLAN_ITEM_LIMIT, MODEL_WORK_PLAN_STATUSES } from "../../orchestration/role-calls/work-plan-contracts.js";
import { EXECUTION_WORKING_DIRECTORY_MAX_LENGTH, EXECUTION_WORKING_DIRECTORY_PATTERN } from "../../orchestration/capability-adapters/index.js";
import { projectCapabilitySelectionProperties } from "./capability-selection-schema.js";
import type { PreparedExecutionAgentCapability } from "./format.js";
import { EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH, EXECUTION_AGENT_TITLE_MAX_LENGTH } from "./contracts.js";

export type ExecutionDecisionSchema = Record<string, unknown>;

export function stableDecisionObject(properties: ExecutionDecisionSchema): ExecutionDecisionSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export function stableDecisionText(maxLength?: number, minLength = 1): ExecutionDecisionSchema {
  return { type: "string", minLength, ...(maxLength === undefined ? {} : { maxLength }) };
}

export function nullableDecisionField(schema: ExecutionDecisionSchema): ExecutionDecisionSchema {
  return { anyOf: [schema, { type: "null" }] };
}

export function stableDecisionPresentation(options: Readonly<{
  includeAcknowledgement: boolean; includeTitle: boolean;
}>): ExecutionDecisionSchema {
  return {
    ...(options.includeAcknowledgement
      ? { acknowledgement: stableDecisionText(EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH, 2) } : {}),
    ...(options.includeTitle ? { title: stableDecisionText(EXECUTION_AGENT_TITLE_MAX_LENGTH, 2) } : {}),
  };
}

export function stableDecisionWorkingDirectory(): ExecutionDecisionSchema {
  return nullableDecisionField({ $ref: "#/$defs/workingDirectory" });
}

export function stableDecisionDefinitions(): ExecutionDecisionSchema {
  return {
    workingDirectory: {
      type: "string", minLength: 1, maxLength: EXECUTION_WORKING_DIRECTORY_MAX_LENGTH,
      pattern: EXECUTION_WORKING_DIRECTORY_PATTERN,
      description: "One portable agent-root-relative directory. When selection is required, null selects the agent root; otherwise null means no new selection.",
    },
    workPlan: stableDecisionObject({
      mode: { type: "string", enum: ["adopt", "progress"] },
      sourceResultRef: stableDecisionText(),
      itemUpdates: {
        type: "array", minItems: 0, maxItems: MODEL_WORK_PLAN_ITEM_LIMIT,
        items: stableDecisionObject({
          itemId: stableDecisionText(), status: { type: "string", enum: [...MODEL_WORK_PLAN_STATUSES] },
        }),
      },
    }),
  };
}

/** Keep the original capability partition; only request-local eligibility moves out. */
export function stableCapabilitySelectionGroups(
  capabilities: readonly PreparedExecutionAgentCapability[],
  definitions: ExecutionDecisionSchema,
): readonly ExecutionDecisionSchema[] {
  return projectCapabilitySelectionProperties(capabilities, []).map((group, index) => {
    const properties = { ...group };
    if (Object.hasOwn(properties, "controlsEvidenceExecutionIds")) {
      const source = properties.controlsEvidenceExecutionIds as ExecutionDecisionSchema;
      properties.controlsEvidenceExecutionIds = {
        ...source, maxItems: ROLE_CAPABILITY_EXECUTION_LIMIT_MAX,
        items: stableDecisionText(),
      };
    }
    if (Object.hasOwn(properties, "selectionControls")) {
      const name = `capabilityControls${index}`;
      definitions[name] = properties.selectionControls;
      properties.selectionControls = { $ref: `#/$defs/${name}` };
    }
    return properties;
  });
}

/** Object-key order is transport detail; ordered schema arrays keep their meaning. */
export function canonicalizeDecisionSchema(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const values = value.map((entry) => canonicalizeDecisionSchema(entry));
    if ((key === "required" || key === "enum") && values.every((entry) => typeof entry === "string"))
      return [...values].sort();
    return values;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((childKey) => [childKey, canonicalizeDecisionSchema((value as Record<string, unknown>)[childKey], childKey)]));
}
