import { describe, expect, it } from "vitest";
import { compileAutomationCreationRecipe, hasAutomationCreationRecipe } from "../capabilities/automation-builder/creation-recipe.js";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { resolveAutomationBinding } from "../automations/binding-resolution.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import { parseAutomationDraftBatch } from "../automations/draft-batch.js";

function fixture() {
  let state = emptyAutomationJournalState();
  let writes = 0;
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const copy = structuredClone(state);
      const result = mutate(copy);
      state = copy;
      writes += 1;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
  return { read: () => structuredClone(state), writes: () => writes,
    async create(value: unknown) {
      const plan = compileAutomationCreationRecipe(value);
      return createAutomationDraftManager({ persistence }).createPlan("Recipe", plan);
    } };
}

const tool = (key: string) => ({ key, kind: "tool", title: key,
  operation: { toolName: "example", operationId: "observe", contractVersion: 1 } });
const agent = (key: string) => ({ key, kind: "agent", title: key, modelProfileId: "model", prompt: "Analyze supplied evidence." });
const prior = (key: string) => ({ kind: "node_result", nodeId: `$${key}`, select: "text" });
const joined = (key: string, group: string) => ({ ...agent(key), inputs: {
  branches: { kind: "branch_results", parallelNodeId: `$${group}` },
} });
const recipe = (steps: unknown[], settings?: unknown) => ({ version: 1, steps, ...(settings === undefined ? {} : { settings }) });

describe("compact automation creation recipes", () => {
  it("dispatches owned recipe fields while retaining malformed recipes for validation", () => {
    expect(hasAutomationCreationRecipe({ version: 1, steps: [] })).toBe(true);
    expect(hasAutomationCreationRecipe({ version: 1, steps: null })).toBe(true);
    expect(hasAutomationCreationRecipe({ version: 1, steps: undefined, commands: [] })).toBe(true);
    expect(hasAutomationCreationRecipe(Object.assign(Object.create(null), { steps: [] }))).toBe(true);
    expect(hasAutomationCreationRecipe(Object.create({ steps: [] }))).toBe(false);
    expect(hasAutomationCreationRecipe({ version: 1, commands: [] })).toBe(false);
    expect(hasAutomationCreationRecipe(null)).toBe(false);
    expect(hasAutomationCreationRecipe([])).toBe(false);
  });

  it("creates a three-step chain with mechanical defaults and exact bindings in one commit", async () => {
    const f = fixture();
    const input = recipe([tool("read"), { ...agent("analyze"), inputs: { evidence: prior("read") } },
      { ...tool("save"), onFailure: "skip", controls: { path: { kind: "run_file", fileName: "report.md" } }, payload: prior("analyze") }],
    { objective: "Read, analyze and save", trigger: { kind: "manual" } });
    const before = structuredClone(input);
    const saved = await f.create(input);
    expect(input).toEqual(before);
    expect(saved.draft.revision).toBe(1);
    expect(f.writes()).toBe(1);
    expect(f.read().drafts).toHaveLength(1);
    expect(f.read().definitions).toEqual([]);
    expect(f.read().grants).toEqual([]);
    expect(saved.draft.definition.objective).toBe("Read, analyze and save");
    const [read, analyze, save] = saved.draft.definition.body.children;
    expect(read).toMatchObject({ id: saved.aliases.read, onFailure: "stop", controls: {} });
    expect(analyze).toMatchObject({ id: saved.aliases.analyze, onFailure: "stop", agentMode: "fast",
      roleInstructions: "", tools: [], result: { kind: "text" }, inputs: { evidence: { nodeId: saved.aliases.read } } });
    expect(save).toMatchObject({ id: saved.aliases.save, onFailure: "skip", payload: { nodeId: saved.aliases.analyze } });
    expect(compileAutomationGraph(saved.draft.definition).ok).toBe(true);
  });

  it("creates nested parallel branches from real leaves, preserves sequence order and joins exact groups", async () => {
    const f = fixture();
    const input = recipe([tool("before"), { key: "outer", kind: "parallel", branches: [
      [{ key: "inner", kind: "parallel", branches: [
        [tool("a"), { ...agent("a2"), inputs: { source: prior("a") } }], [tool("b")],
      ] }, joined("innerJoin", "inner"), tool("leftTail")],
      [tool("c"), { ...agent("c2"), inputs: { source: prior("c") } }],
    ] }, joined("outerJoin", "outer"), { ...tool("save"), payload: prior("outerJoin") }]);
    const plan = compileAutomationCreationRecipe(input);
    expect(plan.commands.map(({ mutation }) => mutation.kind)).not.toContain("move_node");
    expect(plan.commands.filter(({ mutation }) => mutation.kind === "add_node")).toHaveLength(10);
    expect(plan.commands.filter(({ mutation }) => mutation.kind === "wrap_parallel")).toHaveLength(2);
    const saved = await f.create(input);
    const [before, outer, outerJoin, save] = saved.draft.definition.body.children;
    expect(before!.id).toBe(saved.aliases.before);
    if (outer!.kind !== "parallel" || outerJoin!.kind !== "agent") throw new Error("expected_outer_parallel_and_join");
    expect(outer.id).toBe(saved.aliases.outer);
    expect(outer.branches.map(({ id }) => id)).toEqual([saved.aliases["outer.branch1"], saved.aliases["outer.branch2"]]);
    const [inner, innerJoin, leftTail] = outer.branches[0]!.children;
    if (inner!.kind !== "parallel" || innerJoin!.kind !== "agent") throw new Error("expected_nested_parallel_and_join");
    expect(inner.branches.map(({ children }) => children.map(({ id }) => id))).toEqual([
      [saved.aliases.a, saved.aliases.a2], [saved.aliases.b],
    ]);
    expect(leftTail!.id).toBe(saved.aliases.leftTail);
    expect(outer.branches[1]!.children.map(({ id }) => id)).toEqual([saved.aliases.c, saved.aliases.c2]);
    expect(innerJoin.inputs.branches).toEqual({ kind: "branch_results", parallelNodeId: inner.id });
    expect(outerJoin.inputs.branches).toEqual({ kind: "branch_results", parallelNodeId: outer.id });
    expect(save).toMatchObject({ payload: { nodeId: saved.aliases.outerJoin } });
    const compiled = compileAutomationGraph(saved.draft.definition);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
    expect(compiled.graph.steps.map(({ id }) => id)).toEqual([
      saved.aliases.before, saved.aliases.a, saved.aliases.a2, saved.aliases.b, saved.aliases.innerJoin,
      saved.aliases.leftTail, saved.aliases.c, saved.aliases.c2, saved.aliases.outerJoin, saved.aliases.save,
    ]);
    expect(resolveAutomationBinding(outerJoin.inputs.branches!, {
      runInputs: {}, sourceFiles: [], nodeResults: new Map([
        [saved.aliases.leftTail!, { status: "succeeded", text: "Left result" }],
        [saved.aliases.c2!, { status: "succeeded", text: "Right result" }],
      ]), branchResults: new Map([[outer.id, [
        { nodeId: saved.aliases.leftTail!, status: "succeeded" }, { nodeId: saved.aliases.c2!, status: "succeeded" },
      ]]]),
    })).toEqual({ ok: true, value: [
      { nodeId: saved.aliases.leftTail, status: "succeeded", text: "Left result" },
      { nodeId: saved.aliases.c2, status: "succeeded", text: "Right result" },
    ] });
    expect(f.writes()).toBe(1);
  });

  it("preserves literal objects, prompt strings and explicit configuration without interpolation", async () => {
    const f = fixture();
    const literal = { kind: "parallel", key: "$unknown", branches: ["$root"], inner: { kind: "node_result", nodeId: "$missing" } };
    const input = recipe([{ ...agent("literal"), title: "$root", prompt: "Keep $missing and $literal unchanged.",
      roleInstructions: "Explicit role", agentMode: "deep", onFailure: "skip", inputs: { data: { kind: "literal", value: literal } },
    }]);
    const saved = await f.create(input);
    expect(saved.draft.definition.body.children[0]).toMatchObject({ title: "$root", prompt: "Keep $missing and $literal unchanged.",
      roleInstructions: "Explicit role", agentMode: "deep", onFailure: "skip", inputs: { data: { kind: "literal", value: literal } } });
  });

  it("permits a settings-only draft and rejects an empty recipe without a setting command", async () => {
    const f = fixture();
    const saved = await f.create(recipe([], { objective: "Define steps later" }));
    expect(saved.draft.definition.body.children).toEqual([]);
    await expect(f.create(recipe([]))).rejects.toMatchObject({ code: "automation_batch_commands_invalid" });
    await expect(f.create(recipe([], {}))).rejects.toMatchObject({ code: "automation_batch_commands_invalid" });
    expect(f.writes()).toBe(1);
  });

  it.each([
    [recipe([tool("a"), tool("a")]), "automation_batch_alias_duplicate"],
    [recipe([{ key: "a", kind: "parallel", branches: [[tool("a")], [tool("b")]] }]), "automation_batch_alias_duplicate"],
    [recipe([tool("root")]), "automation_batch_alias_invalid"],
    [recipe([tool("a.branch1")]), "automation_batch_alias_invalid"],
    [recipe([tool("a".repeat(49))]), "automation_batch_alias_invalid"],
    [recipe([{ key: "p", kind: "parallel", branches: [[tool("a")]] }]), "automation_parallel_invalid"],
    [recipe([{ key: "p", kind: "parallel", branches: [[], [tool("a")]] }]), "automation_parallel_invalid"],
    [recipe([{ key: "p", kind: "parallel", branches: Array.from({ length: 9 }, (_, i) => [tool(`n${i}`)]) }]), "automation_parallel_invalid"],
    [{ ...recipe([tool("a")]), commands: [] }, "automation_recipe_field_unknown"],
    [{ ...recipe([tool("a")]), publish: true }, "automation_recipe_field_unknown"],
    [recipe([{ key: "p", kind: "parallel", title: "Not supported", branches: [[tool("a")], [tool("b")]] }]), "automation_recipe_field_unknown"],
    [recipe([tool("a")], []), "automation_recipe_invalid"],
    [{ version: 2, steps: [tool("a")] }, "automation_batch_version_invalid"],
    [{ version: 1 }, "automation_recipe_steps_invalid"],
    [recipe([{ key: "a", kind: "sequence", children: [] }]), "automation_recipe_step_kind_invalid"],
    [recipe(Array.from({ length: 33 }, (_, i) => tool(`n${i}`))), "automation_recipe_capacity_exceeded"],
    [recipe([{ ...agent("a"), prompt: "א".repeat(17_000) }]), "automation_batch_too_large"],
  ])("rejects malformed recipes before any draft mutation (%s)", async (input, code) => {
    const f = fixture();
    await expect(f.create(input)).rejects.toMatchObject({ code });
    expect(f.writes()).toBe(0);
    expect(f.read().drafts).toEqual([]);
  });

  it("enforces expanded batch bytes and canonical graph nesting bounds", async () => {
    const f = fixture();
    const large = recipe(Array.from({ length: 8 }, (_, i) => ({ ...agent(`a${i}`), prompt: "x".repeat(3_900) })));
    expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeLessThan(32_768);
    await expect(f.create(large)).rejects.toMatchObject({ code: "automation_batch_too_large", path: "plan" });
    const nested = recipe([{ key: "p1", kind: "parallel", branches: [
      [{ key: "p2", kind: "parallel", branches: [
        [{ key: "p3", kind: "parallel", branches: [[tool("a")], [tool("b")]] }], [tool("c")],
      ] }], [tool("d")],
    ] }]);
    await expect(f.create(nested)).rejects.toMatchObject({ code: "automation_graph_too_deep" });
    expect(f.writes()).toBe(0);
  });

  it.each([0, 1, 2].flatMap((groups) => [false, true].map((settings) => ({ groups, settings }))))(
    "counts all leaves, parallel groups and settings against the advertised capacity: %j", async ({ groups, settings }) => {
      const f = fixture();
      const budget = AUTOMATION_AUTHORING_REFERENCE.bounds.recipe.compiledCommands;
      const leafCount = budget - groups - Number(settings);
      const steps: unknown[] = Array.from({ length: leafCount }, (_, index) => tool(`n${index}`));
      for (let index = 0; index < groups; index += 1) {
        const heads = steps.splice(0, 2);
        steps.unshift({ key: `group${index}`, kind: "parallel", branches: heads.map((head) => [head]) });
      }
      const input = recipe(steps, settings ? { objective: "Capacity boundary" } : undefined);
      const plan = compileAutomationCreationRecipe(input);
      expect(plan.commands).toHaveLength(budget);
      const saved = await f.create(input);
      const graph = compileAutomationGraph(saved.draft.definition);
      expect(graph.ok).toBe(true);
      if (!graph.ok) throw new Error("expected_valid_graph");
      expect(graph.graph.steps).toHaveLength(leafCount);
      expect(graph.graph.parallelGroups).toHaveLength(groups);
      const before = f.read();
      await expect(f.create({ ...input, steps: [...steps, tool("overflow")] })).rejects.toMatchObject({
        code: "automation_recipe_capacity_exceeded", path: "recipe.steps",
      });
      expect(f.read()).toEqual(before);
      expect(f.writes()).toBe(1);
    });

  it("preserves the raw batch capacity independently of compact recipes", () => {
    const commands = Array.from({ length: 32 }, (_, index) => ({ mutation: {
      kind: "update_definition", patch: { title: `Title ${index}` },
    } }));
    expect(parseAutomationDraftBatch({ version: 1, commands }).commands).toHaveLength(32);
    expect(() => parseAutomationDraftBatch({ version: 1, commands: [...commands, commands[0]] }))
      .toThrow("automation_batch_commands_invalid");
  });

  it.each([
    [recipe([{ ...agent("a"), inputs: { source: prior("missing") } }]), "automation_batch_alias_unknown"],
    [recipe([{ ...agent("a"), inputs: { source: prior("future") } }, tool("future")]), "automation_batch_alias_unknown"],
    [recipe([{ ...agent("a"), inputs: { source: { kind: "node_result", nodeId: "unknown", select: "text" } } }]), "automation_dependency_missing"],
    [recipe([{ ...tool("a"), id: "model-invented-id" }]), "automation_graph_invalid"],
    [recipe([{ ...agent("a"), roleInstructions: null }]), "automation_graph_invalid"],
    [recipe([{ ...tool("a"), controls: null }]), "automation_graph_invalid"],
    [recipe([{ kind: "agent", key: "a", title: "No model or prompt" }]), "automation_graph_invalid"],
    [recipe([{ ...agent("a"), result: { kind: "text", acceptance: [] } }]), "automation_graph_invalid"],
    [recipe([tool("a")], { activate: true }), "automation_graph_invalid"],
    [recipe([{ key: "p", kind: "parallel", branches: [
      [tool("a")], [{ ...agent("b"), inputs: { source: prior("a") } }],
    ] }]), "automation_dependency_missing"],
  ])("preserves canonical validation and never saves a partial draft (%s)", async (input, code) => {
    const f = fixture();
    const initial = await f.create(recipe([tool("keep")]));
    const before = f.read();
    await expect(f.create(input)).rejects.toMatchObject({ code });
    expect(f.read()).toEqual(before);
    expect(f.read().drafts).toEqual([initial.draft]);
    expect(f.writes()).toBe(1);
  });
});
