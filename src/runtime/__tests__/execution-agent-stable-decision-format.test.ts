import { describe, expect, test } from "vitest";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import type { ChatMessage, ModelGatewayRequest } from "../../model-gateway/types.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { createExecutionAgentDecisionFormat } from "../steps/execution-agent/format.js";
import { createStableExecutionAgentDecisionFormat } from "../steps/execution-agent/stable-decision-format.js";
import { stableDecisionVariants, stableFormatOptions, stableReadCapability, stableWriteCapability, type DecisionSchemaNode } from "./support/stable-decision-fixture.js";

describe("stable EA provider schema", () => {
  test("serializes deterministically across catalog and schema property order", () => {
    const before = JSON.stringify(stableFormatOptions);
    const first = createStableExecutionAgentDecisionFormat(stableFormatOptions);
    const reordered: CapabilityDescriptor = {
      ...stableWriteCapability,
      controls: { ...stableWriteCapability.controls,
        properties: { content: { minLength: 1, type: "string" }, path: { minLength: 1, type: "string" } },
        required: ["content", "path"],
      },
    };
    const second = createStableExecutionAgentDecisionFormat({ ...stableFormatOptions,
      capabilities: [reordered, stableReadCapability], capabilityCatalogGroupIds: ["write", "read"],
      activeCapabilityCatalogGroupIds: ["write", "read"],
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(stableFormatOptions)).toBe(before);
  });

  test.each([
    { name: "closed scope", active: null, capabilities: [], action: "open_capability_scope", groups: ["read", "write"] },
    { name: "read scope already open", active: ["read"], capabilities: [stableReadCapability], action: "extend_capability_scope", groups: ["write"] },
    { name: "all scopes already open", active: ["read", "write"], capabilities: [stableReadCapability, stableWriteCapability], action: null, groups: [] },
  ])("the provider schema admits only valid scope transitions for $name", ({ active, capabilities, action, groups }) => {
    const format = createStableExecutionAgentDecisionFormat({ ...stableFormatOptions,
      activeCapabilityCatalogGroupIds: active, capabilities,
    });
    const transitions = stableDecisionVariants(format.schema).filter((variant) =>
      variant.properties?.action?.enum?.some((value) => value === "open_capability_scope" || value === "extend_capability_scope"));
    expect(transitions.map((variant) => variant.properties!.action!.enum![0])).toEqual(action ? [action] : []);
    if (action) expect(transitions[0]!.properties!.catalogGroupIds!.items!.enum).toEqual(groups);
    for (const selectedAction of ["open_capability_scope", "extend_capability_scope"]) {
      for (const selectedGroups of [["read"], ["write"], ["read", "write"], ["foreign"]]) {
        const decision = { action: selectedAction, catalogGroupIds: selectedGroups,
          workPlan: null, interaction: null };
        const issue = validateJsonSchemaValue(format.schema, { decision });
        const allowed = selectedAction === action && selectedGroups.every((group) => groups.includes(group));
        expect(issue === undefined, JSON.stringify({ active, selectedAction, selectedGroups })).toBe(allowed);
      }
    }
  });

  test("keeps exact controls while evidence, batch and work-plan eligibility remain live state", () => {
    const stable = createStableExecutionAgentDecisionFormat(stableFormatOptions);
    const variants = stableDecisionVariants(stable.schema);
    const single = variants.find((variant) => variant.properties?.capabilityId?.enum?.includes("write_file"))!;
    expect(single.properties!.controlsEvidenceExecutionIds).toMatchObject({ type: "array", maxItems: 192, items: { type: "string", minLength: 1 } });
    expect(single.properties!.controlsEvidenceExecutionIds!.items).not.toHaveProperty("maxLength");
    expect(single.properties!.selectionControls).toHaveProperty("$ref");
    const batch = variants.find((variant) => variant.properties?.action?.enum?.includes("invoke_capabilities"))!;
    expect(batch.properties!.invocations).toMatchObject({ maxItems: 64 });
    expect(JSON.stringify(stable)).not.toContain("execution-first");
    const first = createExecutionAgentDecisionFormat({ capabilities: [stableWriteCapability], eligibleControlsEvidenceExecutionIds: ["execution-first"] });
    const next = createExecutionAgentDecisionFormat({ capabilities: [stableWriteCapability], eligibleControlsEvidenceExecutionIds: ["execution-first", "execution-second"] });
    expect(first.schema).not.toEqual(next.schema);
    expect(createStableExecutionAgentDecisionFormat(stableFormatOptions)).toEqual(stable);
  });

  test("keeps identical serialized native tool definitions for consecutive Luna requests", () => {
    const request: ModelGatewayRequest = {
      agentMode: "reasoning", modelStep: "execution.decision",
      modelPolicy: { providers: { openai: { type: "openai" } },
        profiles: { luna: { provider: "openai", model: "gpt-6-luna", contextWindowTokens: 32000 } },
        defaults: { profileId: "luna" } },
      format: createStableExecutionAgentDecisionFormat(stableFormatOptions),
      messages: [{ role: "system", content: "Stable policy." }, { role: "user", content: "Turn one." }],
    };
    const first = buildOpenAIResponsesPayload(request);
    const next = buildOpenAIResponsesPayload({ ...request, messages: [...request.messages as ChatMessage[], { role: "assistant", content: "Done." }, { role: "user", content: "Turn two." }] });
    expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
    expect((next.input as unknown[]).slice(0, 2)).toEqual(first.input);
    expect(next.tool_choice).toEqual(first.tool_choice);
  });

  test("omits presentation and services unavailable in the live contract", () => {
    const format = createStableExecutionAgentDecisionFormat({ ...stableFormatOptions,
      allowPlanner: false, allowWorkPlan: false, allowMemoryRecall: false, allowAuditor: false, allowDirectResponse: false,
      allowMemoryAuthoring: false, allowUserInteraction: false,
    });
    const variants = stableDecisionVariants(format.schema);
    const actions = variants.flatMap((variant) => variant.properties!.action!.enum!);
    expect(actions).not.toEqual(expect.arrayContaining(["invoke_planner", "invoke_auditor", "recall_memory"]));
    for (const variant of variants) {
      expect(variant.required).toEqual(Object.keys(variant.properties!).sort());
      expect(variant.properties).not.toHaveProperty("acknowledgement");
      expect(variant.properties).not.toHaveProperty("title");
      expect(variant.properties).not.toHaveProperty("workPlan");
      expect(variant.properties).not.toHaveProperty("interaction");
    }
  });

  test("bounds the complete 130-capability structural schema without optional-field cross products", () => {
    const capabilities: CapabilityDescriptor[] = Array.from({ length: 130 }, (_, index) => ({
      ...stableReadCapability, capabilityId: `read_${index.toString().padStart(3, "0")}`,
      controls: { type: "object", additionalProperties: false,
        properties: { [`field_${index}`]: { type: "string", minLength: 1 } }, required: [`field_${index}`] },
    }));
    const schema = createStableExecutionAgentDecisionFormat({ ...stableFormatOptions, capabilities }).schema;
    const nodes = collectNodes(schema);
    const propertyCount = nodes.reduce((sum, node) => sum + Object.keys(node.properties ?? {}).length, 0);
    const enumCount = nodes.reduce((sum, node) => sum + (node.enum?.length ?? 0), 0);
    expect(stableDecisionVariants(schema).length).toBeLessThan(140);
    expect(propertyCount).toBeLessThan(5000);
    expect(enumCount).toBeLessThan(1000);
    expect(JSON.stringify(schema).length).toBeLessThan(200_000);
  });
});

function collectNodes(value: unknown): DecisionSchemaNode[] {
  if (Array.isArray(value)) return value.flatMap(collectNodes);
  if (value === null || typeof value !== "object") return [];
  return [value as DecisionSchemaNode, ...Object.values(value).flatMap(collectNodes)];
}
