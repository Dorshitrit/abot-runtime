import { describe, expect, it } from "vitest";
import { applyAutomationDraftBatch, parseAutomationDraftBatch } from "../automations/draft-batch.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { parseAutomationDefinition } from "../automations/definition-input.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { resolveAutomationBinding } from "../automations/binding-resolution.js";
import type { AgentNode, AutomationOutputSchema, AutomationRevision, ToolNode } from "../automations/definition-contracts.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import { normalizeSchedulerSchedule } from "../scheduler/schedule-validation.js";
import { AUTOMATION_AUTHORING_REFERENCE as reference } from "../capabilities/automation-builder/authoring-reference.js";
import { compileAutomationCreationRecipe } from "../capabilities/automation-builder/creation-recipe.js";

function apply(commands: readonly unknown[], current = createEmptyAutomationDefinition("example", "Example")) {
  return applyAutomationDraftBatch(current, parseAutomationDraftBatch({ version: 1, commands }), current.revision + 1);
}

function add(as: string, index: number, node: Omit<AgentNode, "id"> | Omit<ToolNode, "id"> = reference.nodes.tool) {
  return { as, mutation: { kind: "add_node", parentSequenceId: "$root", index, nodeWithoutId: node } };
}

describe("canonical automation authoring reference", () => {
  it("compiles the creation example with defaults and a bound result", () => {
    const result = applyAutomationDraftBatch(createEmptyAutomationDefinition("example", "Example"),
      compileAutomationCreationRecipe(reference.createPlanExample), 1);
    expect(compileAutomationGraph(result.definition).ok).toBe(true);
    expect(result.definition.body.children).toHaveLength(2);
    expect(result.definition.body.children[1]).toMatchObject({ kind: "agent", onFailure: "stop",
      agentMode: "fast", result: { kind: "text" }, inputs: {
        evidence: { kind: "node_result", nodeId: result.aliases.evidence, select: "data" },
      } });
  });

  it("is a bounded, serializable passive contract with canonical limits", () => {
    expect(reference).toMatchObject({ kind: "automation_authoring_reference_v1", version: 1,
      authority: "capability_contract" });
    expect(JSON.parse(JSON.stringify(reference))).toEqual(reference);
    const { permissions, ...grammar } = reference;
    expect(Buffer.byteLength(JSON.stringify(grammar), "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(Buffer.byteLength(JSON.stringify(permissions), "utf8")).toBeLessThanOrEqual(1280);
    expect(Buffer.byteLength(JSON.stringify(reference), "utf8"))
      .toBeLessThanOrEqual(12 * 1024 + 1280 + Buffer.byteLength(',"permissions":'));
    expect(reference.definition.limits).toEqual(DEFAULT_AUTOMATION_LIMITS);
    expect(Object.keys(reference.mutations).sort()).toEqual([
      "add_node", "move_node", "remove_node", "update_definition", "update_node", "wrap_parallel",
    ]);
    const example = applyAutomationDraftBatch(createEmptyAutomationDefinition("example", "Example"),
      parseAutomationDraftBatch(reference.planExample), 1);
    expect(compileAutomationGraph(example.definition).ok).toBe(true);
    expect(example.aliases.first).toBe(example.definition.body.children[0]!.id);
  });

  it("applies all six documented mutations with canonical alias and branch handling", () => {
    const result = apply([
      add("first", 0), add("second", 1),
      { as: "temporary", mutation: { ...reference.mutations.add_node, index: 2 } },
      { mutation: reference.mutations.update_node },
      { as: "group", mutation: reference.mutations.wrap_parallel },
      { mutation: { ...reference.mutations.move_node, nodeId: "$temporary" } },
      { mutation: { ...reference.mutations.remove_node, nodeId: "$temporary" } },
      { mutation: reference.mutations.update_definition },
    ]);
    expect(result.definition.objective).toBe(reference.mutations.update_definition.patch.objective);
    expect(compileAutomationGraph(result.definition).ok).toBe(true);
    const group = result.definition.body.children[0]!;
    expect(group.kind).toBe("parallel");
    if (group.kind !== "parallel") throw new Error("expected_parallel");
    expect(group.branches[0]!.id).toBe(result.aliases["group.branch1"]);
    expect(group.branches[0]!.children).toHaveLength(1);
    expect(group.branches[0]!.children[0]).toMatchObject({ id: result.aliases.first, title: "Updated title" });
    expect(result.aliases.temporary).toBeUndefined();
  });

  it("builds and resolves every documented binding against exact settled sources", () => {
    const result = apply([
      { mutation: { kind: "update_definition", patch: { source: reference.definition.sourceExample,
        inputs: reference.definition.inputsExample } } },
      add("first", 0), add("second", 1),
      { as: "group", mutation: reference.mutations.wrap_parallel },
      add("analysis", 1, { ...reference.nodes.agent, result: reference.nodes.result.json,
        acceptance: reference.nodes.acceptanceExample }),
      add("consumer", 2, { ...reference.nodes.agent, inputs: reference.bindings.examples }),
    ]);
    expect(parseAutomationDefinition(result.definition)).toEqual(result.definition);
    expect(compileAutomationGraph(result.definition).ok).toBe(true);
    const consumer = result.definition.body.children[2] as AgentNode;
    const structuredEvidence = { records: [{ id: "record-1", title: "Exact source" }],
      complete: true, metadata: { version: 3 } };
    const context = { runId: "run-example", runInputs: { topic: "Bound input" },
      sourceFiles: [{ inputId: "input", sourceId: result.definition.source!.sourceId,
        originalPath: "/source/input.txt", snapshotPath: "/snapshot/input.txt", version: "v1", sizeBytes: 4 }],
      nodeResults: new Map([
        [result.aliases.first!, { status: "succeeded" as const, text: "1 record", data: structuredEvidence }],
        [result.aliases.second!, { status: "succeeded" as const, text: "Second evidence" }],
        [result.aliases.analysis!, { status: "succeeded" as const, data: { title: "Bound title" } }],
      ]), branchResults: new Map([[result.aliases.group!, [
        { nodeId: result.aliases.first!, status: "succeeded" as const },
        { nodeId: result.aliases.second!, status: "succeeded" as const },
      ]]]) };
    for (const binding of Object.values(consumer.inputs))
      expect(resolveAutomationBinding(binding, context).ok).toBe(true);
    expect(resolveAutomationBinding(consumer.inputs.earlierText!, context)).toEqual({ ok: true, value: "1 record" });
    expect(resolveAutomationBinding(consumer.inputs.earlierWholeData!, context))
      .toEqual({ ok: true, value: structuredEvidence });
    expect(resolveAutomationBinding(consumer.inputs.earlierData!, context)).toEqual({ ok: true, value: "Bound title" });
    expect(resolveAutomationBinding(consumer.inputs.sourceFile!, context)).toEqual({ ok: true, value: "/snapshot/input.txt" });
    expect(resolveAutomationBinding(consumer.inputs.runInput!, context)).toEqual({ ok: true, value: "Bound input" });
  });

  it("accepts every advertised result property shape through the canonical graph validator", () => {
    const properties = reference.nodes.schemaPropertyExamples;
    const result = apply([add("analysis", 0, { ...reference.nodes.agent,
      result: { kind: "json", schema: { type: "object", additionalProperties: false,
        properties, required: Object.keys(properties) } } })]);
    expect(compileAutomationGraph(result.definition).ok).toBe(true);
  });

  it.each([
    { name: "properties", maximum: reference.nodes.resultSchemaBounds.maxProperties,
      properties: (size: number): AutomationOutputSchema["properties"] => Object.fromEntries(
        Array.from({ length: size }, (_, index) => [`field${index}`, { type: "boolean" }])) },
    { name: "string length", maximum: reference.nodes.resultSchemaBounds.maxStringLength,
      properties: (size: number): AutomationOutputSchema["properties"] => ({
        text: { type: "string", minLength: 0, maxLength: size },
      }) },
    { name: "array items", maximum: reference.nodes.resultSchemaBounds.maxArrayItems,
      properties: (size: number): AutomationOutputSchema["properties"] => ({
        items: { type: "array", minItems: 0, maxItems: size, items: { type: "boolean" } },
      }) },
  ])("matches the canonical result-schema limit for $name", ({ maximum, properties }) => {
    const command = (size: number) => add("analysis", 0, { ...reference.nodes.agent,
      result: { kind: "json", schema: { type: "object", additionalProperties: false,
        properties: properties(size), required: Object.keys(properties(size)) } } });
    expect(compileAutomationGraph(apply([command(maximum)]).definition).ok).toBe(true);
    expect(() => apply([command(maximum + 1)])).toThrow("automation_output_schema_invalid");
  });

  it.each([
    { name: "title", maximum: reference.nodes.bounds.maxTitleLength,
      patch: (size: number) => ({ title: "x".repeat(size) }) },
    { name: "prompt", maximum: reference.nodes.bounds.maxInstructionLength,
      patch: (size: number) => ({ prompt: "x".repeat(size) }) },
    { name: "role instructions", maximum: reference.nodes.bounds.maxInstructionLength,
      patch: (size: number) => ({ roleInstructions: "x".repeat(size) }) },
    { name: "input bindings", maximum: reference.nodes.bounds.maxBindings,
      patch: (size: number) => ({ inputs: Object.fromEntries(Array.from({ length: size }, (_, index) =>
        [`input${index}`, { kind: "literal" as const, value: index }])) }) },
    { name: "selected tools", maximum: reference.nodes.bounds.maxSelectedTools,
      patch: (size: number) => ({ tools: Array.from({ length: size }, () =>
        ({ operation: reference.nodes.operationReference, usage: "available" as const })) }) },
  ])("matches the canonical node limit for $name", ({ maximum, patch }) => {
    expect(compileAutomationGraph(apply([add("analysis", 0,
      { ...reference.nodes.agent, ...patch(maximum) })]).definition).ok).toBe(true);
    expect(() => apply([add("analysis", 0,
      { ...reference.nodes.agent, ...patch(maximum + 1) })])).toThrow("automation_graph_invalid");
  });

  it.each(reference.definition.schedules)("validates the documented $kind schedule", (schedule) => {
    const result = apply([{ mutation: { kind: "update_definition", patch: {
      trigger: { kind: "schedule", schedule }, limits: reference.definition.limits,
    } } }, add("first", 0)]);
    expect(result.definition.trigger).toEqual({ kind: "schedule", schedule });
    expect(normalizeSchedulerSchedule(schedule, Date.parse("2029-01-01T00:00:00Z")).kind).toBe(schedule.kind);
  });

  it.each(reference.definition.triggers)("validates the documented $kind trigger", (trigger) => {
    const result = apply([{ mutation: { kind: "update_definition", patch: {
      trigger, source: reference.definition.sourceExample,
    } } }, add("first", 0)]);
    expect(compileAutomationGraph(result.definition).ok).toBe(true);
    expect(result.definition.source!.sourceId).not.toBe("");
  });

  it("removes only the documented optional fields and preserves the remaining definition", () => {
    const initial = apply([
      { mutation: { kind: "update_definition", patch: {
        workingDirectory: "/absolute/runtime/work", source: reference.definition.sourceExample,
      } } },
      add("first", 0, { ...reference.nodes.tool, payload: reference.nodes.payloadExample }),
    ]);
    const result = apply([
      { mutation: { kind: "update_definition", patch: reference.definition.removals.definitionPatch } },
      { mutation: { kind: "update_node", nodeId: initial.aliases.first,
        patch: reference.definition.removals.toolNodePatch } },
    ], initial.definition as AutomationRevision);
    expect(result.definition.workingDirectory).toBeUndefined();
    expect(result.definition.source).toBeUndefined();
    expect(result.definition.body.children[0]).not.toHaveProperty("payload");
    expect(result.definition.body.children[0]!.id).toBe(initial.aliases.first);
    expect(result.definition.limits).toEqual(DEFAULT_AUTOMATION_LIMITS);
  });
});
