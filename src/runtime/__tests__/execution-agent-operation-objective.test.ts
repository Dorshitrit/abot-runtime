import { describe, expect, test } from "vitest";

import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import {
  buildExecutionAgentInstructions,
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
} from "../steps/execution-agent/index.js";
import { EXECUTION_AGENT_OPERATION_OBJECTIVE_MAX_LENGTH } from "../steps/execution-agent/capability-invocation-contract.js";
import { buildExecutionControlsRefinementInstructions } from "../steps/execution-agent/refinement-prompt.js";

const inspectPath = {
  capabilityId: "inspect_path",
  summary: "Inspect one selected path.",
  effect: "observation",
  controls: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["path"],
  },
  selectionControlIds: ["path"],
} as const satisfies CapabilityDescriptor;

const readRange = {
  capabilityId: "read_range",
  summary: "Read one bounded range from a selected path.",
  effect: "observation",
  controls: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096 },
      startLine: { type: "integer", minimum: 1, maximum: 20_000 },
      endLine: { type: "integer", minimum: 1, maximum: 20_000 },
    },
    required: ["path", "startLine", "endLine"],
  },
  selectionControlIds: ["path"],
} as const satisfies CapabilityDescriptor;

const options = Object.freeze({
  capabilities: Object.freeze([inspectPath, readRange]),
  maxBatchCapabilityExecutions: 2,
});

describe("Execution Agent operation objective", () => {
  test("separates identical selection schemas by refinement authority", () => {
    const decisionSchemaVariants = decisionVariants(
      createExecutionAgentDecisionFormat(options).schema,
    );
    const variants = decisionSchemaVariants.filter((variant) =>
      readEnum(variant.properties.action).includes("invoke_capability"),
    );
    expect(variants).toHaveLength(2);

    const complete = variantForCapability(variants, inspectPath.capabilityId);
    expect(complete.required).not.toContain("operationObjective");
    expect(complete.properties).not.toHaveProperty("operationObjective");

    const refinement = variantForCapability(variants, readRange.capabilityId);
    expect(refinement.required).toContain("operationObjective");
    expect(refinement.properties.operationObjective).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: EXECUTION_AGENT_OPERATION_OBJECTIVE_MAX_LENGTH,
    });

    const batch = decisionSchemaVariants.find((variant) =>
      readEnum(variant.properties.action).includes("invoke_capabilities"),
    );
    const invocationArray = asRecord(batch?.properties.invocations);
    const batchVariants = objectVariants(invocationArray?.items);
    expect(
      variantForCapability(batchVariants, inspectPath.capabilityId).required,
    ).not.toContain("operationObjective");
    expect(
      variantForCapability(batchVariants, readRange.capabilityId).required,
    ).toContain("operationObjective");
  });

  test("requires the objective only for invocations with remaining controls", () => {
    const operationObjective =
      "Continue reading only lines 241 through 480 from project/index.html.";
    expect(
      parseDecision({
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: inspectPath.capabilityId,
            intent: "Inspect the exact path.",
            selectionControls: { path: "project/index.html" },
          },
          {
            capabilityId: readRange.capabilityId,
            intent: "Continue the bounded read.",
            operationObjective,
            selectionControls: { path: "project/index.html" },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      decision: {
        action: "invoke_capabilities",
        invocations: [
          {
            capabilityId: inspectPath.capabilityId,
            intent: "Inspect the exact path.",
            selectionControls: { path: "project/index.html" },
            controls: { path: "project/index.html" },
          },
          {
            capabilityId: readRange.capabilityId,
            intent: "Continue the bounded read.",
            operationObjective,
            selectionControls: { path: "project/index.html" },
          },
        ],
      },
    });

    expect(
      parseDecision({
        action: "invoke_capability",
        capabilityId: readRange.capabilityId,
        intent: "Continue the bounded read.",
        selectionControls: { path: "project/index.html" },
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_operation_objective_invalid",
        }),
      ]),
    });

    expect(
      parseDecision({
        action: "invoke_capability",
        capabilityId: inspectPath.capabilityId,
        intent: "Inspect the exact path.",
        operationObjective: "Inject an unused instruction.",
        selectionControls: { path: "project/index.html" },
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_decision_shape_invalid",
        }),
      ]),
    });

    expect(
      parseDecision({
        action: "invoke_capability",
        capabilityId: readRange.capabilityId,
        intent: "Continue the bounded read.",
        operationObjective: "x".repeat(
          EXECUTION_AGENT_OPERATION_OBJECTIVE_MAX_LENGTH + 1,
        ),
        selectionControls: { path: "project/index.html" },
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "execution_agent_operation_objective_invalid",
        }),
      ]),
    });
  });

  test("keeps client intent separate and makes the refinement objective exclusive", () => {
    const decisionInstructions = buildExecutionAgentInstructions({
      hasCapabilities: true,
      hasCapabilityCatalogGroups: false,
      capabilityScopeAction: null,
      allowPlanner: false,
      availableAuditCriterionCount: 0,
      allowRespond: false,
      includeAcknowledgement: false,
      includeTitle: false,
      includeWorkingDirectory: false,
    });
    expect(decisionInstructions).toContain(
      "complete bounded operation for that invocation alone",
    );
    expect(decisionInstructions).toContain(
      "Intent is presentation metadata only",
    );

    const refinementInstructions = buildExecutionControlsRefinementInstructions(
      [
        {
          slot: "invocation_1",
          capabilityId: readRange.capabilityId,
          guidance: "",
        },
      ],
    );
    expect(refinementInstructions).toContain("sole semantic authority");
    expect(refinementInstructions).toContain(
      "never replace it, broaden it, or add another requested outcome",
    );
  });
});

function parseDecision(decision: unknown) {
  return parseExecutionAgentDecisionOutput(
    JSON.stringify({ decision }),
    options,
  );
}

type DecisionVariant = Readonly<{
  properties: Record<string, unknown>;
  required: readonly string[];
}>;

function decisionVariants(schema: unknown): DecisionVariant[] {
  const root = asRecord(schema);
  const properties = asRecord(root?.properties);
  return objectVariants(properties?.decision);
}

function objectVariants(schema: unknown): DecisionVariant[] {
  const recordSchema = asRecord(schema);
  const variants = Array.isArray(recordSchema?.anyOf)
    ? recordSchema.anyOf
    : [recordSchema];
  return variants.map((variant) => {
    const record = asRecord(variant);
    const variantProperties = asRecord(record?.properties);
    if (!variantProperties || !Array.isArray(record?.required)) {
      throw new Error("invalid execution decision variant");
    }
    return {
      properties: variantProperties,
      required: record.required as string[],
    };
  });
}

function variantForCapability(
  variants: readonly DecisionVariant[],
  capabilityId: string,
): DecisionVariant {
  const variant = variants.find((candidate) =>
    readEnum(candidate.properties.capabilityId).includes(capabilityId),
  );
  if (!variant) throw new Error(`missing variant for ${capabilityId}`);
  return variant;
}

function readEnum(value: unknown): readonly string[] {
  const record = asRecord(value);
  return Array.isArray(record?.enum) ? (record.enum as string[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
