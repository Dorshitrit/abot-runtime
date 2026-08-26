import { describe, expect, test } from "vitest";

import {
  projectOpenAIResponsesFormat,
  projectOllamaFormat,
} from "../../model-gateway/structured-output.js";
import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH } from "../orchestration/role-calls/index.js";
import { createPlannerDecisionFormat } from "../steps/planner-decision/format.js";
import { createReviewerDecisionFormat } from "../steps/reviewer-decision/format.js";
import type { ReviewerReviewSnapshot } from "../steps/reviewer-decision/contracts.js";
import { createSupervisorDecisionFormat } from "../steps/supervisor-decision/format.js";
import { createSupervisorWorkingDirectoryFormat } from "../steps/supervisor-decision/working-directory.js";
import { createWorkerDecisionFormat } from "../steps/worker-decision/format.js";

const reviewSnapshot = {
  reviewScopeId: "review-scope-1",
  reviewerCallId: "call-reviewer",
  callerCallId: "call-planner",
  sourceRevision: 1,
  projectionComplete: true,
  freshness: "current",
  allowedGapKinds: ["missing_evidence"],
  subjects: [],
  facts: [],
  evidence: [],
} satisfies ReviewerReviewSnapshot;

const quotedWorkerIntent = 'Inspect fetch("products.json").';
const secondQuotedWorkerIntent = 'Inspect fetch("backup.json").';
const observationCapability = {
  capabilityId: "example.observe",
  summary: "Observe one current value.",
  effect: "observation" as const,
  controls: {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  },
};

const inspectTargetCapability = {
  capabilityId: "inspect_target",
  summary: "Inspect one bounded file window.",
  effect: "observation" as const,
  controls: {
    type: "object" as const,
    properties: {
      path: { type: "string" as const, minLength: 1, maxLength: 4_096 },
      start_line: { type: "integer" as const, minimum: 1, maximum: 1_000_000 },
      end_line: { type: "integer" as const, minimum: 1, maximum: 1_000_000 },
      locator: { type: "string" as const, minLength: 1, maxLength: 4_096 },
      context_lines: { type: "integer" as const, minimum: 1, maximum: 30 },
    },
    required: ["path"],
    additionalProperties: false as const,
  },
};
const inspectJsonCapability = {
  capabilityId: "inspect_json",
  summary: "Inspect one bounded JSON file.",
  effect: "observation" as const,
  controls: {
    type: "object" as const,
    properties: {
      path: { type: "string" as const, minLength: 1, maxLength: 1_024 },
      maxDepth: { type: "integer" as const, minimum: 0, maximum: 6 },
    },
    required: ["path"],
    additionalProperties: false as const,
  },
};
const inspectProjectCapability = {
  capabilityId: "inspect_project",
  summary: "Inspect one bounded project tree.",
  effect: "observation" as const,
  controls: {
    type: "object" as const,
    properties: {
      path: { type: "string" as const, minLength: 0, maxLength: 1_024 },
      depth: { type: "integer" as const, minimum: 0, maximum: 6 },
      maxEntries: { type: "integer" as const, minimum: 1, maximum: 500 },
    },
    required: [],
    additionalProperties: false as const,
  },
};
const operationTargetIntent = "Create the requested product data file.";
const operationTargetPath = "products.json";
const operationTargetCapability = {
  capabilityId: "write_complete_file",
  summary: "Write one complete file.",
  effect: "mutation" as const,
  controls: {
    type: "object" as const,
    properties: {
      path: { type: "string" as const, minLength: 1, maxLength: 4_096 },
    },
    required: ["path"],
    additionalProperties: false as const,
  },
  selectionControlIds: ["path"],
};
const operationTargetSelectionFormat = createWorkerDecisionFormat({
  capabilities: [operationTargetCapability],
});
const operationTargetExecutionFormat = createWorkerDecisionFormat({
  capabilities: [operationTargetCapability],
  pendingCapabilitySelection: {
    capabilityId: operationTargetCapability.capabilityId,
    intent: operationTargetIntent,
    selectionControls: { path: operationTargetPath },
  },
});
const lunaBatchIntents = [
  "Inspect the project tree.",
  "Inspect index.html.",
  "Inspect styles.css.",
  "Inspect script.js.",
  "Inspect products.json.",
] as const;
const lunaBatchFormat = createWorkerDecisionFormat({
  capabilities: [
    inspectTargetCapability,
    inspectJsonCapability,
    inspectProjectCapability,
  ],
  maxBatchCapabilityExecutions: 5,
  allowSingleCapabilityInvocation: false,
  pendingCapabilityBatchSelection: [
    { capabilityId: "inspect_project", intent: lunaBatchIntents[0] },
    { capabilityId: "inspect_target", intent: lunaBatchIntents[1] },
    { capabilityId: "inspect_target", intent: lunaBatchIntents[2] },
    { capabilityId: "inspect_target", intent: lunaBatchIntents[3] },
    { capabilityId: "inspect_json", intent: lunaBatchIntents[4] },
  ],
});
const plannerFormat = createPlannerDecisionFormat({
  availableChildRoleIds: ["worker"],
  availableWorkerCapabilityCatalog: [
    {
      groupId: "example",
      memberCount: 1,
      effects: ["observation"],
    },
  ],
});
const supervisorWorkingDirectoryFormat =
  createSupervisorWorkingDirectoryFormat();

const roleFormats = [
  ["supervisor", createSupervisorDecisionFormat()],
  ["planner", plannerFormat],
  ["worker", createWorkerDecisionFormat()],
  [
    "worker single controls",
    createWorkerDecisionFormat({
      capabilities: [observationCapability],
      pendingCapabilitySelection: {
        capabilityId: observationCapability.capabilityId,
        intent: quotedWorkerIntent,
      },
    }),
  ],
  ["worker batch controls", lunaBatchFormat],
  ["worker operation-target selection", operationTargetSelectionFormat],
  ["worker operation-target controls", operationTargetExecutionFormat],
  ["reviewer", createReviewerDecisionFormat(reviewSnapshot)],
] as const satisfies readonly (readonly [
  string,
  ModelGatewayJsonSchemaFormat,
])[];

describe("canonical structured role-decision contract", () => {
  test("preserves the strict Supervisor working-directory-only phase across providers", () => {
    const openAI = projectOpenAIResponsesFormat(
      supervisorWorkingDirectoryFormat,
    );
    const ollama = projectOllamaFormat(supervisorWorkingDirectoryFormat);
    const expected = {
      type: "object",
      required: ["workingDirectory"],
      additionalProperties: false,
      properties: {
        workingDirectory: { type: "string", minLength: 1 },
      },
    };

    expect(supervisorWorkingDirectoryFormat.schema).toMatchObject(expected);
    expect(openAI.format!.schema).toEqual(
      supervisorWorkingDirectoryFormat.schema,
    );
    expect(openAI.diagnostics).toEqual([]);
    expect(ollama.format).toMatchObject(expected);
    expect(ollama.diagnostics).toEqual([
      {
        action: "removed",
        keyword: "maxLength",
        path: "/properties/workingDirectory/maxLength",
        reason: "ollama_grammar_unsupported_post_validated_constraint",
      },
    ]);
    for (const schema of [
      supervisorWorkingDirectoryFormat.schema,
      openAI.format!.schema,
      ollama.format,
    ]) {
      const serialized = JSON.stringify(schema);
      expect(serialized).not.toContain("roleId");
      expect(serialized).not.toContain("objective");
      expect(serialized).not.toContain("workerCapabilityScope");
      expect(serialized).not.toContain("catalogGroupIds");
    }
  });

  test("preserves required Planner Worker workingDirectory across provider projections", () => {
    const openAI = projectOpenAIResponsesFormat(plannerFormat);
    const ollama = projectOllamaFormat(plannerFormat);
    const canonicalWorker = workerInvokeVariant(plannerFormat.schema);
    const openAIWorker = workerInvokeVariant(openAI.format!.schema);
    const ollamaWorker = workerInvokeVariant(ollama.format);

    for (const variant of [canonicalWorker, openAIWorker, ollamaWorker]) {
      expect(variant.required).toContain("workingDirectory");
      expect(variant.properties).toHaveProperty("workingDirectory");
    }
    expect(canonicalWorker.properties.workingDirectory).toMatchObject({
      type: "string",
      maxLength: ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
    });
    expect(openAIWorker.properties.workingDirectory).toEqual(
      canonicalWorker.properties.workingDirectory,
    );
    expect(ollama.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining(
            "/properties/workingDirectory/maxLength",
          ),
        }),
      ]),
    );
  });

  test("keeps frozen Worker selections out of controls-only provider schemas", () => {
    const controlsFormats = roleFormats.filter(([roleId]) =>
      roleId.includes("controls"),
    );
    expect(controlsFormats).toHaveLength(3);
    controlsFormats.forEach(([, format]) => {
      const schema = JSON.stringify(format.schema);
      expect(schema).not.toContain(JSON.stringify(quotedWorkerIntent));
      expect(schema).not.toContain(JSON.stringify(secondQuotedWorkerIntent));
      lunaBatchIntents.forEach((intent) => {
        expect(schema).not.toContain(JSON.stringify(intent));
      });
      expect(schema).not.toContain('"capabilityId"');
      expect(schema).not.toContain('"intent"');
      expect(schema).not.toContain(operationTargetPath);
    });
  });

  test("preserves selection-bound targets across OpenAI and Ollama projections", () => {
    const selectionSchema = JSON.stringify(
      operationTargetSelectionFormat.schema,
    );
    expect(selectionSchema).toContain('"selectionControls"');
    expect(selectionSchema).toContain('"path"');
    expect(selectionSchema).not.toContain(operationTargetPath);

    const expectedExecution = {
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                controls: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
              },
            },
          ],
        },
      },
    };
    const executionSchema = JSON.stringify(
      operationTargetExecutionFormat.schema,
    );
    expect(executionSchema).not.toContain('"selectionControls"');
    expect(executionSchema).not.toContain('"path"');
    expect(executionSchema).not.toContain(operationTargetPath);

    const openAISelection = projectOpenAIResponsesFormat(
      operationTargetSelectionFormat,
    );
    expect(openAISelection.format!.schema).toEqual(
      operationTargetSelectionFormat.schema,
    );
    expect(openAISelection.diagnostics).toEqual([]);
    const openAIExecution = projectOpenAIResponsesFormat(
      operationTargetExecutionFormat,
    );
    expect(openAIExecution.format!.schema).toMatchObject(expectedExecution);
    expect(openAIExecution.diagnostics).toEqual([]);

    const ollamaSelection = projectOllamaFormat(operationTargetSelectionFormat);
    expect(ollamaSelection.format).toMatchObject({
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                selectionControls: {
                  properties: {
                    path: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(ollamaSelection.format)).not.toContain(
      operationTargetPath,
    );
    expect(ollamaSelection.diagnostics).toHaveLength(
      operationTargetSelectionFormat.postValidatedSchemaConstraints?.length ??
        0,
    );
    const ollamaExecution = projectOllamaFormat(operationTargetExecutionFormat);
    expect(ollamaExecution.format).toMatchObject(expectedExecution);
    expect(ollamaExecution.diagnostics).toHaveLength(
      operationTargetExecutionFormat.postValidatedSchemaConstraints?.length ??
        0,
    );
  });

  test("preserves heterogeneous frozen batch slots across provider projections", () => {
    const expectedSlotMapping = {
      properties: {
        decision: {
          anyOf: [
            {},
            {},
            {
              properties: {
                invocations: {
                  type: "object",
                  properties: {
                    invocation_1: {
                      description: expect.stringContaining("inspect_project"),
                      properties: {
                        controls: {
                          properties: {
                            path: {},
                            depth: {},
                            maxEntries: {},
                          },
                        },
                      },
                    },
                    invocation_2: {
                      description: expect.stringContaining("inspect_target"),
                      properties: {
                        controls: {
                          properties: {
                            path: {},
                            start_line: {},
                            end_line: {},
                            locator: {},
                            context_lines: {},
                          },
                        },
                      },
                    },
                    invocation_3: {
                      description: expect.stringContaining("inspect_target"),
                    },
                    invocation_4: {
                      description: expect.stringContaining("inspect_target"),
                    },
                    invocation_5: {
                      description: expect.stringContaining("inspect_json"),
                      properties: {
                        controls: {
                          properties: { path: {}, maxDepth: {} },
                        },
                      },
                    },
                  },
                  required: [
                    "invocation_1",
                    "invocation_2",
                    "invocation_3",
                    "invocation_4",
                    "invocation_5",
                  ],
                  additionalProperties: false,
                },
              },
            },
          ],
        },
      },
    };

    expect(lunaBatchFormat.schema).toMatchObject(expectedSlotMapping);
    const openAI = projectOpenAIResponsesFormat(lunaBatchFormat);
    expect(openAI.format).toMatchObject({
      type: "json_schema",
      schema: expectedSlotMapping,
    });
    expect(openAI.instructions).toEqual([]);
    expect(openAI.diagnostics).toEqual([]);
    const ollama = projectOllamaFormat(lunaBatchFormat);
    expect(ollama.format).toMatchObject(expectedSlotMapping);
    expect(ollama.diagnostics).toHaveLength(
      lunaBatchFormat.postValidatedSchemaConstraints?.length ?? 0,
    );
  });

  test.each(roleFormats)(
    "%s remains one strict root object for OpenAI",
    (_roleId, format) => {
      expect(format.schema).toMatchObject({
        type: "object",
        required: ["decision"],
        additionalProperties: false,
      });
      expect(format.schema).not.toHaveProperty("oneOf");
      expect(format.schema).not.toHaveProperty("anyOf");
      expect(format.schema).not.toHaveProperty("allOf");
      assertStrictObjectSchemas(format.schema);

      const projection = projectOpenAIResponsesFormat(format);
      expect(projection.format).toEqual({
        type: "json_schema",
        name: format.name,
        schema: format.schema,
        strict: true,
      });
      expect(projection.instructions).toEqual([]);
      expect(projection.diagnostics).toEqual([]);
    },
  );

  test.each(roleFormats)(
    "%s projects the same decision envelope for Ollama",
    (_roleId, format) => {
      const projection = projectOllamaFormat(format);
      expect(projection.format).toMatchObject({
        type: "object",
        required: ["decision"],
        additionalProperties: false,
      });
      expect(projection.format).not.toHaveProperty("oneOf");
      expect(projection.format).not.toHaveProperty("anyOf");
      expect(projection.diagnostics).toHaveLength(
        format.postValidatedSchemaConstraints?.length ?? 0,
      );
    },
  );
});

function assertStrictObjectSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertStrictObjectSchemas);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "object") {
    const properties = isRecord(value.properties) ? value.properties : {};
    expect(value.additionalProperties).toBe(false);
    expect(value.required).toEqual(Object.keys(properties));
  }
  if (value.type === "array") {
    expect(value).toHaveProperty("items");
  }
  Object.values(value).forEach(assertStrictObjectSchemas);
}

function workerInvokeVariant(schema: unknown): {
  properties: Record<string, unknown>;
  required: unknown[];
} {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new Error("structured decision schema missing properties");
  }
  const decision = schema.properties.decision;
  if (!isRecord(decision)) {
    throw new Error("structured decision schema missing decision");
  }
  const variants = Array.isArray(decision.anyOf) ? decision.anyOf : [decision];
  const worker = variants.find((variant) => {
    if (!isRecord(variant) || !isRecord(variant.properties)) return false;
    const roleId = variant.properties.roleId;
    return (
      isRecord(roleId) &&
      Array.isArray(roleId.enum) &&
      roleId.enum.includes("worker")
    );
  });
  if (
    !isRecord(worker) ||
    !isRecord(worker.properties) ||
    !Array.isArray(worker.required)
  ) {
    throw new Error("structured decision schema missing Worker invoke variant");
  }
  return {
    properties: worker.properties,
    required: worker.required,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
