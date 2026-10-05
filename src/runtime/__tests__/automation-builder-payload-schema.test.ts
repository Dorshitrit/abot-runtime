import { describe, expect, it } from "vitest";
import { projectOllamaFormat, projectOpenAIResponsesFormat } from "../../model-gateway/structured-output.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { applyAutomationDraftBatch, parseAutomationDraftBatch } from "../automations/draft-batch.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { AUTOMATION_AUTHORING_REFERENCE as reference } from "../capabilities/automation-builder/authoring-reference.js";
import { AUTOMATION_BUILDER_PAYLOAD_FORMAT as format } from "../capabilities/automation-builder/payload-schema.js";
import { createAutomationBuilderToolModule } from "../capabilities/automation-builder/tool-module.js";
import { compileAutomationCreationRecipe } from "../capabilities/automation-builder/creation-recipe.js";

const plan = (commands: readonly unknown[]) => ({ version: 1, commands });
const add = (as: string, index: number, nodeWithoutId: unknown = reference.nodes.tool) => ({
  as, mutation: { kind: "add_node", parentSequenceId: "$root", index, nodeWithoutId },
});

function expectCanonicalPlan(value: unknown) {
  expect(validateJsonSchemaValue(format, value)).toBeUndefined();
  const parsed = parseAutomationDraftBatch(value);
  return applyAutomationDraftBatch(createEmptyAutomationDefinition("example", "Example"), parsed, 1);
}

function expectCanonicalRecipe(value: unknown) {
  expect(validateJsonSchemaValue(format, value)).toBeUndefined();
  return applyAutomationDraftBatch(createEmptyAutomationDefinition("example", "Example"),
    compileAutomationCreationRecipe(value), 1);
}

const recipeTool = (key: string) => ({ key, kind: "tool", title: "Read evidence", operation: reference.nodes.operationReference });
const recipeAgent = { key: "analysis", kind: "agent", title: "Analyze evidence", modelProfileId: "catalog_model_id",
  prompt: "Use the supplied evidence." };

describe("automation builder generation schema", () => {
  it("uses one declared schema-aware payload stage without changing the batch wire format", () => {
    const module = createAutomationBuilderToolModule(() => { throw new Error("unexpected_execution"); }, async () => undefined);
    expect(module.definition.payloadChannelSpec).toEqual({ params: ["planJson"], outputParam: "planJson",
      generationMode: "raw_text", stages: [{ outputParam: "planJson", responseFormat: format }] });
    expect(format).toMatchObject({ type: "json_schema", strict: false, schema: { type: "object" } });
    expect(Buffer.byteLength(JSON.stringify(format))).toBeLessThanOrEqual(16 * 1024);
    expectCanonicalPlan(reference.planExample);
  });

  it.each(Object.values(reference.mutations))("accepts the documented $kind mutation envelope", (mutation) => {
    const input = plan([{ mutation }]);
    expect(validateJsonSchemaValue(format, input)).toBeUndefined();
    expect(parseAutomationDraftBatch(input).commands[0]!.mutation.kind).toBe(mutation.kind);
  });

  it("keeps all six mutation variants executable by the existing atomic parser", () => {
    const result = expectCanonicalPlan(plan([
      add("first", 0), add("second", 1),
      { as: "temporary", mutation: { ...reference.mutations.add_node, index: 2 } },
      { mutation: reference.mutations.update_node },
      { as: "group", mutation: reference.mutations.wrap_parallel },
      { mutation: { ...reference.mutations.move_node, nodeId: "$temporary" } },
      { mutation: { ...reference.mutations.remove_node, nodeId: "$temporary" } },
      { mutation: reference.mutations.update_definition },
    ]));
    expect(compileAutomationGraph(result.definition).ok).toBe(true);
    expect(result.aliases.temporary).toBeUndefined();
  });

  it.each(["update_node", "update_definition", "remove_node", "move_node"] as const)(
    "rejects an alias on %s in both generation and canonical contracts", (kind) => {
      const input = plan([{ as: "changed", mutation: reference.mutations[kind] }]);
      expect(validateJsonSchemaValue(format, input)).toBeDefined();
      expect(() => parseAutomationDraftBatch(input)).toThrow("automation_batch_alias_target_invalid");
    },
  );

  it("passes every binding shape and JSON result data through unchanged", () => {
    const input = plan([
      { mutation: { kind: "update_definition", patch: { source: reference.definition.sourceExample,
        inputs: reference.definition.inputsExample } } },
      add("first", 0), add("second", 1),
      { as: "group", mutation: reference.mutations.wrap_parallel },
      add("analysis", 1, { ...reference.nodes.agent, result: reference.nodes.result.json,
        acceptance: reference.nodes.acceptanceExample }),
      add("consumer", 2, { ...reference.nodes.agent, inputs: { ...reference.bindings.examples,
        arbitraryJson: { kind: "literal", value: { list: [null, true, 4.5, { nested: "value" }] } } } }),
    ]);
    const before = structuredClone(input);
    const result = expectCanonicalPlan(input);
    expect(input).toEqual(before);
    expect(result.definition.body.children[2]).toMatchObject({ inputs: {
      arbitraryJson: { kind: "literal", value: { list: [null, true, 4.5, { nested: "value" }] } },
    } });
  });

  it("keeps optional fields absent and accepts explicit canonical removals", () => {
    const initial = expectCanonicalPlan(plan([add("first", 0), add("analysis", 1, reference.nodes.agent)]));
    expect(initial.definition.body.children[0]).not.toHaveProperty("payload");
    expect(initial.definition.body.children[1]).not.toHaveProperty("acceptance");
    const patch = plan([
      { mutation: { kind: "update_node", nodeId: initial.aliases.first, patch: { payload: null } } },
      { mutation: { kind: "update_definition", patch: { source: null, workingDirectory: null } } },
    ]);
    expect(validateJsonSchemaValue(format, patch)).toBeUndefined();
    const changed = applyAutomationDraftBatch(initial.definition, parseAutomationDraftBatch(patch), 2);
    expect(changed.definition).not.toHaveProperty("workingDirectory");
    expect(changed.definition.body.children[0]).not.toHaveProperty("payload");
  });

  it.each(["text", "json"] as const)("accepts %s results with scalar acceptance only at the node level", (kind) => {
    const node = { ...reference.nodes.agent, result: reference.nodes.result[kind],
      ...(kind === "json" ? { acceptance: reference.nodes.acceptanceExample } : {}) };
    expectCanonicalPlan(plan([add("analysis", 0, node)]));
  });

  it.each(reference.definition.schedules)("preserves the documented $kind schedule shape", (schedule) => {
    expectCanonicalPlan(plan([{ mutation: { kind: "update_definition", patch: {
      trigger: { kind: "schedule", schedule }, limits: reference.definition.limits,
    } } }, add("first", 0)]));
  });

  it("rejects misplaced result acceptance before the builder implementation is reached", () => {
    const invalidNode = { ...reference.nodes.agent, result: {
      ...reference.nodes.result.json, acceptance: [{ field: "ready", equals: true }],
    } };
    const input = plan([add("analysis", 0, invalidNode)]);
    expect(validateJsonSchemaValue(format, input)).toBeDefined();
    expect(() => applyAutomationDraftBatch(createEmptyAutomationDefinition("example", "Example"),
      parseAutomationDraftBatch(input), 1)).toThrow("automation_graph_invalid");
  });

  it.each([
    { version: 1, commands: [{ mutation: { kind: "add_node", parentSequenceId: "$root", index: 0,
      node: reference.nodes.agent } }] },
    { version: 1, commands: [{ kind: "add_node", parentSequenceId: "$root", index: 0,
      nodeWithoutId: reference.nodes.agent }] },
    { version: 1, commands: [] },
    { version: 2, commands: [add("first", 0)] },
    { version: 1, commands: [add("first", 0)], unexpected: true },
  ])("rejects malformed command structure", (input) => {
    expect(validateJsonSchemaValue(format, input)).toBeDefined();
  });

  it("accepts compact ordered steps and applies only the canonical defaults", () => {
    const input = { version: 1, settings: { objective: "Summarize the evidence" }, steps: [recipeTool("first"),
      { ...recipeAgent, inputs: { evidence: { kind: "node_result", nodeId: "$first", select: "text" } } }] };
    const before = structuredClone(input);
    const result = expectCanonicalRecipe(input);
    expect(input).toEqual(before);
    expect(result.definition.body.children).toMatchObject([
      { kind: "tool", controls: {}, onFailure: "stop" },
      { kind: "agent", onFailure: "stop", agentMode: "fast", roleInstructions: "", tools: [], result: { kind: "text" },
        inputs: { evidence: { kind: "node_result", nodeId: result.aliases.first, select: "text" } } },
    ]);
  });

  it("preserves optional recipe settings, bindings, JSON results and acceptance", () => {
    const result = expectCanonicalRecipe({ version: 1, settings: { workingDirectory: null,
      inputs: { flags: { first: true, values: [1, null, "text"] } } }, steps: [{ ...recipeAgent,
      onFailure: "skip", agentMode: "deep", roleInstructions: "Analyze the requested inputs.",
      inputs: { flags: { kind: "run_input", input: "flags" } },
      result: reference.nodes.result.json, acceptance: reference.nodes.acceptanceExample }] });
    expect(result.definition).not.toHaveProperty("workingDirectory");
    expect(result.definition.body.children[0]).toMatchObject({ onFailure: "skip", agentMode: "deep",
      result: reference.nodes.result.json, acceptance: reference.nodes.acceptanceExample });
  });

  it("projects recursive parallel recipes compactly and compiles their nested branches", () => {
    const result = expectCanonicalRecipe({ version: 1, steps: [{ key: "outer", kind: "parallel", branches: [
      [{ key: "inner", kind: "parallel", branches: [[recipeTool("one")], [recipeTool("two")]] }],
      [recipeTool("three")],
    ] }, { ...recipeAgent, inputs: { evidence: { kind: "branch_results", parallelNodeId: "$outer" } } }] });
    expect(compileAutomationGraph(result.definition).ok).toBe(true);
    expect(result.definition.body.children[0]).toMatchObject({ kind: "parallel" });
  });

  it("rejects misplaced acceptance in a recipe result and canonically rechecks nested schema references", () => {
    const invalid = { ...recipeAgent, result: { ...reference.nodes.result.json,
      acceptance: reference.nodes.acceptanceExample } };
    expect(validateJsonSchemaValue(format, { version: 1, steps: [invalid] })).toBeDefined();
    const nested = { version: 1, steps: [{ key: "group", kind: "parallel", branches: [[invalid], [recipeTool("other")]] }] };
    expect(() => expectCanonicalRecipe(nested)).toThrow("automation_graph_invalid");
  });

  it("retains canonical route and field bounds beyond the structural generation schema", () => {
    const conflicting = { version: 1, commands: [add("first", 0)], steps: [recipeTool("first")] };
    expect(validateJsonSchemaValue(format, conflicting)).toBeUndefined();
    expect(() => parseAutomationDraftBatch(conflicting)).toThrow();
    expect(() => compileAutomationCreationRecipe(conflicting)).toThrow();
    const oversized = { version: 1, steps: [{ ...recipeAgent, prompt: "x".repeat(8_193) }] };
    expect(validateJsonSchemaValue(format, oversized)).toBeUndefined();
    expect(() => expectCanonicalRecipe(oversized)).toThrow("automation_graph_invalid");
    const invalidBinding = { version: 1, steps: [recipeTool("first"), { ...recipeAgent, inputs: { evidence: {
      kind: "node_result", nodeId: "$first", select: "text", pointer: "/invented",
    } } }] };
    expect(validateJsonSchemaValue(format, invalidBinding)).toBeUndefined();
    expect(() => expectCanonicalRecipe(invalidBinding)).toThrow("automation_output_pointer_invalid");
  });

  it("projects the same object-root grammar and reference definitions to both providers", () => {
    const before = structuredClone(format);
    const openai = projectOpenAIResponsesFormat(format);
    expect(openai.instructions).toEqual([]);
    expect(openai.format).toMatchObject({ type: "json_schema", strict: false, schema: format.schema });
    const ollama = projectOllamaFormat(format);
    expect(ollama.format).toMatchObject({ type: "object" });
    expect(ollama.format).toEqual(format.schema);
    expect(ollama.diagnostics).toEqual([]);
    expect(ollama.format).toHaveProperty("$defs.valueBinding");
    expect(format).toEqual(before);
    const oversized = plan([add("analysis", 0, { ...reference.nodes.agent, prompt: "x".repeat(8_193) })]);
    expect(validateJsonSchemaValue(format, oversized)).toBeUndefined();
    expect(() => expectCanonicalPlan(oversized)).toThrow("automation_graph_invalid");
  });

  it("bounds recipe arrays to the actual creation capacity", () => {
    const steps = Array.from({ length: reference.bounds.recipe.executableNodes }, (_, index) => recipeTool(`n${index}`));
    expectCanonicalRecipe({ version: 1, steps });
    expect(validateJsonSchemaValue(format, { version: 1, steps: [...steps, recipeTool("extra")] })).toBeDefined();
    expect(() => compileAutomationCreationRecipe({ version: 1, settings: { objective: "One extra unit" }, steps }))
      .toThrow("automation_recipe_capacity_exceeded");
  });
});
