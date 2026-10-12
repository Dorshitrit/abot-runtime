import { describe, expect, test } from "vitest";
import { projectOpenAIResponsesFormat } from "../../model-gateway/structured-output/openai-format.js";
import { projectOllamaFormat } from "../../model-gateway/structured-output/ollama-format.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import {
  createExecutionAgentDecisionFormat,
  type ExecutionAgentDecisionContractOptions,
} from "../steps/execution-agent/index.js";
import { inlineLocalSchemaReferences } from "./support/inline-local-schema-references.js";

const options = {
  allowRespond: true,
  allowMemoryRecall: true,
  allowPlanner: true,
  allowAuditor: true,
  availableAuditCriterionIds: ["criterion-1"],
  capabilityCatalogGroupIds: ["read", "write"],
  activeCapabilityCatalogGroupIds: ["read"],
  capabilities: [
    {
      capabilityId: "observe_file",
      summary: "Observe one file.",
      effect: "observation",
      controls: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
        required: ["path"],
      },
      selectionControlIds: ["path"],
    },
  ],
} as const satisfies ExecutionAgentDecisionContractOptions;

function workPlan(sourceCount: number) {
  const sources = Array.from({ length: sourceCount }, (_, index) => ({
    sourceResultRef: `proposal-${index}`,
    itemIds: [`write-${index}`, `verify-${index}`],
  }));
  return { sources, current: sources[0] };
}

type Variant = { properties: Record<string, unknown>; required: string[] };
function variants(schema: Record<string, unknown>): Variant[] {
  return (schema.properties as { decision: { anyOf: Variant[] } }).decision
    .anyOf;
}

describe("EA shared work-plan report schema", () => {
  test.each([1, 6, 20])(
    "shares reports for %i proposals while preserving every action",
    (count) => {
      const baseline = createExecutionAgentDecisionFormat(options).schema;
      const shared = createExecutionAgentDecisionFormat({
        ...options,
        workPlan: workPlan(count),
      }).schema;
      const decisions = variants(shared);
      const plain = decisions.filter(
        (variant) => !Object.hasOwn(variant.properties, "workPlan"),
      );
      expect(plain).toEqual(variants(baseline));
      const reports = decisions.filter((variant) =>
        Object.hasOwn(variant.properties, "workPlan"),
      );
      expect(reports).toHaveLength(plain.length);
      expect(
        new Set(
          reports.map((variant) => JSON.stringify(variant.properties.workPlan)),
        ).size,
      ).toBe(1);
      const definitions = shared.$defs as Record<string, { anyOf: unknown[] }>;
      expect(Object.keys(definitions)).toHaveLength(1);
      expect(Object.values(definitions)[0]!.anyOf).toHaveLength(count + 1);

      const expanded = inlineLocalSchemaReferences(shared);
      for (const [index, variant] of variants(expanded).entries()) {
        const { workPlan: report, ...properties } = variant.properties;
        const original = variants(baseline)[Math.floor(index / 2)]!;
        expect(properties).toEqual(original.properties);
        expect(variant.required).toEqual(
          index % 2 === 0
            ? original.required
            : [...original.required, "workPlan"],
        );
        if (index % 2 === 1)
          expect(report).toEqual(Object.values(definitions)[0]);
      }
      expect(JSON.stringify(shared).length).toBeLessThan(
        JSON.stringify(expanded).length * 0.65,
      );
    },
  );

  test("rebuilds offered identities without leaking a prior request or adopted plan", () => {
    const before = createExecutionAgentDecisionFormat({
      ...options,
      workPlan: workPlan(6),
    });
    const beforeBytes = JSON.stringify(before);
    const next = createExecutionAgentDecisionFormat({
      ...options,
      workPlan: {
        sources: [
          { sourceResultRef: "other-request", itemIds: ["other-item"] },
        ],
      },
    });
    expect(JSON.stringify(next)).not.toContain("proposal-0");
    expect(JSON.stringify(next)).not.toContain('"progress"');
    expect(JSON.stringify(before)).toBe(beforeBytes);
    expect(
      createExecutionAgentDecisionFormat({
        ...options,
        workPlan: { sources: [] },
      }),
    ).toEqual(createExecutionAgentDecisionFormat(options));
  });

  test.each(["OpenAI", "Ollama"])(
    "preserves reference binding through the %s schema projection",
    (provider) => {
      const format = createExecutionAgentDecisionFormat({
        ...options,
        workPlan: workPlan(6),
      });
      const schema =
        provider === "OpenAI"
          ? (projectOpenAIResponsesFormat(format).format!.schema as Record<
              string,
              unknown
            >)
          : (projectOllamaFormat(format).format as Record<string, unknown>);
      expect(schema.$defs).toEqual(format.schema.$defs);
      const validate = (sourceResultRef: string, itemId: string) =>
        validateJsonSchemaValue(inlineLocalSchemaReferences(schema), {
          decision: {
            action: "respond",
            workPlan: {
              mode: "progress",
              sourceResultRef,
              itemUpdates: [{ itemId, status: "done" }],
            },
          },
        });
      expect(validate("proposal-0", "write-0")).toBeUndefined();
      expect(validate("proposal-0", "write-1")).toBeDefined();
      expect(validate("proposal-1", "write-1")).toBeDefined();
      if (provider === "OpenAI") expect(schema).toEqual(format.schema);
      if (provider === "Ollama")
        expect(projectOllamaFormat(format).diagnostics.length).toBeGreaterThan(
          0,
        );
    },
  );
});
