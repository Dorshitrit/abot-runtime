import { describe, expect, it } from "vitest";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { resolveAutomationBinding } from "../automations/binding-resolution.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";

function fixture() {
  let state = emptyAutomationJournalState();
  let commits = 0;
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const copy = structuredClone(state);
      const result = mutate(copy);
      state = copy;
      commits += 1;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
  return { persistence, drafts: createAutomationDraftManager({ persistence }),
    read: () => structuredClone(state), commits: () => commits };
}

const tool = (title: string) => ({ kind: "tool", title, onFailure: "stop",
  operation: { toolName: "example", operationId: "read", contractVersion: 1 }, controls: {} });
const agent = (title: string) => ({ kind: "agent", title, onFailure: "stop", modelProfileId: "model",
  agentMode: "fast", roleInstructions: "Analyze input", prompt: "Summarize", inputs: {},
  tools: [], result: { kind: "text" } });
const add = (as: string, index: number, nodeWithoutId = tool(as), parentSequenceId = "$root") =>
  ({ as, mutation: { kind: "add_node", parentSequenceId, index, nodeWithoutId } });
const plan = (commands: unknown[]) => ({ version: 1, commands });

describe("atomic automation draft plans", () => {
  it("creates a connected chain with exact inputs in one revision and one journal commit", async () => {
    const f = fixture();
    const result = await f.drafts.createPlan("Research", plan([
      add("search", 0),
      { as: "summary", mutation: { kind: "add_node", parentSequenceId: "$root", index: 1,
        nodeWithoutId: { ...agent("Summarize"), inputs: {
          source: { kind: "node_result", nodeId: "$search", select: "text" },
        } } } },
      add("save", 2, { ...tool("Save"), controls: {
        content: { kind: "node_result", nodeId: "$summary", select: "text" },
      } }),
    ]));
    expect(f.commits()).toBe(1);
    expect(result.draft.revision).toBe(1);
    expect(result.draft.definition.revision).toBe(1);
    expect(result.aliases.root).toBe(result.draft.definition.body.id);
    expect(new Set(Object.values(result.aliases)).size).toBe(4);
    expect(Object.values(result.aliases).every((id) => /^n_[a-f0-9]{32}$/u.test(id))).toBe(true);
    const compiled = compileAutomationGraph(result.draft.definition);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("expected_compiled_chain");
    expect(compiled.graph.steps.map((step) => step.dependsOn)).toEqual([
      [], [result.aliases.search], [result.aliases.summary],
    ]);
    const save = result.draft.definition.body.children[2]!;
    if (save.kind !== "tool") throw new Error("expected_tool");
    expect(resolveAutomationBinding(save.controls.content!, {
      runInputs: {}, sourceFiles: [], branchResults: new Map(), nodeResults: new Map([
        [result.aliases.summary!, { status: "succeeded", text: "Verified summary" }],
        ["unrelated", { status: "succeeded", text: "Never selected" }],
      ]),
    })).toEqual({ ok: true, value: "Verified summary" });
    expect(f.read().definitions).toEqual([]);
    expect(f.read().grants).toEqual([]);
  });

  it("resolves generated parallel and branch aliases and validates the final join", async () => {
    const f = fixture();
    const result = await f.drafts.createPlan("Parallel", plan([
      add("a", 0), add("b", 1), add("extra", 2),
      { as: "research", mutation: { kind: "wrap_parallel", nodeIds: ["$b", "$a"] } },
      { mutation: { kind: "move_node", nodeId: "$extra", parentSequenceId: "$research.branch1", index: 1 } },
      { as: "merge", mutation: { kind: "add_node", parentSequenceId: "$root", index: 1,
        nodeWithoutId: { ...agent("Merge"), inputs: {
          branches: { kind: "branch_results", parallelNodeId: "$research" },
        } } } },
    ]));
    const parallel = result.draft.definition.body.children[0]!;
    if (parallel.kind !== "parallel") throw new Error("expected_parallel");
    expect(parallel.id).toBe(result.aliases.research);
    expect(parallel.branches.map(({ id }) => id)).toEqual([
      result.aliases["research.branch1"], result.aliases["research.branch2"],
    ]);
    expect(parallel.branches[0]!.children.map(({ id }) => id)).toEqual([result.aliases.a, result.aliases.extra]);
    expect(compileAutomationGraph(result.draft.definition).ok).toBe(true);
    expect(f.commits()).toBe(1);
  });

  it("preserves literal objects, prompts, and other non-binding strings byte-for-byte", async () => {
    const f = fixture();
    const literal = { kind: "node_result", nodeId: "$unknown", text: "$root" };
    const result = await f.drafts.createPlan("Exact literals", plan([
      add("source", 0),
      { as: "reader", mutation: { kind: "add_node", parentSequenceId: "$root", index: 1,
        nodeWithoutId: { ...agent("$source"), prompt: "$unknown is literal prompt text", inputs: {
          value: { kind: "literal", value: literal },
        } } } },
      { mutation: { kind: "update_node", nodeId: "$source", patch: {
        payload: { kind: "literal", value: "$reader" },
      } } },
    ]));
    expect(result.draft.definition.body.children[1]).toMatchObject({ title: "$source",
      prompt: "$unknown is literal prompt text", inputs: { value: { kind: "literal", value: literal } } });
    expect(result.draft.definition.body.children[0]).toMatchObject({ payload: { kind: "literal", value: "$reader" } });
  });

  it("resolves patched inputs and payloads and permits a temporarily incomplete graph", async () => {
    const f = fixture();
    const result = await f.drafts.createPlan("Final graph", plan([
      add("source", 0),
      { as: "agent", mutation: { kind: "add_node", parentSequenceId: "$root", index: 1,
        nodeWithoutId: agent("Summarize") } },
      { mutation: { kind: "update_node", nodeId: "$agent", patch: { inputs: {
        source: { kind: "node_result", nodeId: "$source", select: "text" },
      } } } },
      // This temporarily puts a consumer before its dependency; only the final graph is committed.
      { mutation: { kind: "move_node", nodeId: "$source", parentSequenceId: "$root", index: 2 } },
      { mutation: { kind: "move_node", nodeId: "$source", parentSequenceId: "$root", index: 0 } },
      add("save", 2),
      { mutation: { kind: "update_node", nodeId: "$save", patch: {
        payload: { kind: "node_result", nodeId: "$agent", select: "text" },
      } } },
    ]));
    expect(result.draft.definition.body.children[1]).toMatchObject({ inputs: {
      source: { nodeId: result.aliases.source },
    } });
    expect(result.draft.definition.body.children[2]).toMatchObject({ payload: { nodeId: result.aliases.agent } });
    expect(result.draft.revision).toBe(1);
    expect(f.commits()).toBe(1);
  });

  it("commits many existing-draft edits once, rejects stale revisions, and keeps sibling steps", async () => {
    const f = fixture();
    const initial = await f.drafts.createPlan("Original", plan([add("a", 0), add("b", 1)]));
    const updated = await f.drafts.applyPlan(initial.draft.automationId, 1, plan([
      { mutation: { kind: "update_definition", patch: { title: "Updated" } } },
      { mutation: { kind: "update_node", nodeId: initial.aliases.a, patch: { title: "Renamed" } } },
      add("c", 2),
    ]));
    expect(updated.draft.revision).toBe(2);
    expect(updated.draft.definition.revision).toBe(2);
    expect(updated.draft.storageRevision).toBe(2);
    expect(updated.draft.definition.body.children[1]).toEqual(initial.draft.definition.body.children[1]);
    expect(f.commits()).toBe(2);
    await expect(f.drafts.applyPlan(initial.draft.automationId, 1, plan([add("d", 3)])))
      .rejects.toThrow("automation_revision_conflict");
    expect(f.read().drafts).toEqual([updated.draft]);
    expect(f.commits()).toBe(2);
  });

  it("rolls back all earlier commands on final dependency validation failure", async () => {
    const f = fixture();
    const initial = await f.drafts.createPlan("Keep", plan([add("a", 0)]));
    const before = f.read();
    await expect(f.drafts.applyPlan(initial.draft.automationId, 1, plan([
      { mutation: { kind: "update_definition", patch: { title: "Must not save" } } },
      add("bad", 1, { ...tool("Bad"), controls: {
        value: { kind: "node_result", nodeId: "nonexistent", select: "text" },
      } }),
    ]))).rejects.toMatchObject({ code: "automation_dependency_missing", path: "body.children.1.controls.value" });
    expect(f.read()).toEqual(before);
    expect(f.commits()).toBe(1);
    await expect(f.drafts.createPlan("No partial draft", plan([
      add("a", 0), { mutation: { kind: "remove_node", nodeId: "$missing" } },
    ]))).rejects.toMatchObject({ code: "automation_batch_alias_unknown", path: "plan.commands.1.mutation.nodeId" });
    expect(f.read()).toEqual(before);
  });

  it("preserves the archived guard and does not create publication or grant state", async () => {
    const f = fixture();
    const initial = await f.drafts.createPlan("Archived", plan([add("a", 0)]));
    await f.persistence.update((state) => { state.drafts[0] = { ...state.drafts[0]!, archivedAt: "2026-09-30T00:00:00Z" }; });
    const before = f.read();
    await expect(f.drafts.applyPlan(initial.draft.automationId, 1, plan([add("b", 1)])))
      .rejects.toThrow("automation_archived");
    expect(f.read()).toEqual(before);
  });

  it("returns only aliases still present in the committed graph", async () => {
    const f = fixture();
    const result = await f.drafts.createPlan("Surviving aliases", plan([
      add("a", 0), add("b", 1),
      { as: "parallel", mutation: { kind: "wrap_parallel", nodeIds: ["$a", "$b"] } },
      { mutation: { kind: "remove_node", nodeId: "$parallel" } },
      add("survivor", 0),
    ]));
    expect(result.aliases).toEqual({ root: result.draft.definition.body.id,
      survivor: result.draft.definition.body.children[0]!.id });
  });

  it("preserves a canonical malformed field path together with its batch command", async () => {
    const f = fixture();
    await expect(f.drafts.createPlan("Malformed binding", plan([
      add("source", 0), add("bad", 1, { ...tool("Bad"), controls: {
        content: { kind: "node_result", nodeId: "$source", select: "unsupported" },
      } }),
    ]))).rejects.toMatchObject({ code: "automation_graph_invalid",
      path: "body.children.1.controls.content.select", commandPath: "plan.commands.1.mutation" });
    expect(f.commits()).toBe(0);
    expect(f.read().drafts).toEqual([]);
  });

  it("identifies a missing canonical node field without accepting or saving its replacement", async () => {
    const f = fixture();
    const initial = await f.drafts.createPlan("Keep", plan([add("first", 0)]));
    const before = f.read();
    await expect(f.drafts.applyPlan(initial.draft.automationId, 1, plan([
      { mutation: { kind: "update_definition", patch: { title: "Must not save" } } },
      { mutation: { kind: "add_node", parentSequenceId: "$root", index: 1, node: tool("Invalid") } },
    ]))).rejects.toMatchObject({ code: "automation_batch_field_required",
      path: "plan.commands.1.mutation.nodeWithoutId" });
    expect(f.read()).toEqual(before);
    expect(f.commits()).toBe(1);
  });

  it.each([
    { kind: "add_node", parentSequenceId: "$root", index: 0, nodeWithoutId: tool("New") },
    { kind: "update_node", nodeId: "$step", patch: { title: "Updated" } },
    { kind: "remove_node", nodeId: "$step" },
    { kind: "move_node", nodeId: "$step", parentSequenceId: "$root", index: 0 },
    { kind: "wrap_parallel", nodeIds: ["$a", "$b"] },
    { kind: "update_definition", patch: { title: "Updated" } },
  ])("reports the exact required field omitted from $kind", async (mutation) => {
    const f = fixture();
    for (const field of Object.keys(mutation)) {
      const incomplete = Object.fromEntries(Object.entries(mutation).filter(([key]) => key !== field));
      await expect(f.drafts.createPlan("Invalid", plan([{ mutation: incomplete }])))
        .rejects.toMatchObject({ code: "automation_batch_field_required", path: `plan.commands.0.mutation.${field}` });
    }
    expect(f.commits()).toBe(0);
    expect(f.read().drafts).toEqual([]);
  });

  it.each(["unknown", "toString", "constructor", "__proto__", null, 1, {}, []])(
    "rejects an unsupported mutation kind without consulting inherited keys (%s)", async (kind) => {
      const f = fixture();
      await expect(f.drafts.createPlan("Invalid", plan([{ mutation: { kind } }])))
        .rejects.toMatchObject({ code: "automation_batch_mutation_kind_invalid", path: "plan.commands.0.mutation.kind" });
      expect(f.commits()).toBe(0);
      expect(f.read().drafts).toEqual([]);
    },
  );

  it.each([
    [{ version: 2, commands: [add("a", 0)] }, "automation_batch_version_invalid", "plan.version"],
    [{ ...plan([add("a", 0)]), publish: true }, "automation_batch_field_unknown", "plan.publish"],
    [plan([{ ...add("a", 0), grant: "full_plus" }]), "automation_batch_field_unknown", "plan.commands.0.grant"],
    [plan([{ mutation: { ...add("a", 0).mutation, activate: true } }]),
      "automation_batch_field_unknown", "plan.commands.0.mutation.activate"],
    [plan([]), "automation_batch_commands_invalid", "plan.commands"],
    [plan(Array.from({ length: 33 }, (_, i) => add(`a${i}`, i))), "automation_batch_commands_invalid", "plan.commands"],
    [plan([add("root", 0)]), "automation_batch_alias_invalid", "plan.commands.0.as"],
    [plan([add("a.branch1", 0)]), "automation_batch_alias_invalid", "plan.commands.0.as"],
    [plan([add("a", 0), add("a", 1)]), "automation_batch_alias_duplicate", "plan.commands.1.as"],
    [plan([{ as: "bad", mutation: { kind: "update_definition", patch: { title: "X" } } }]),
      "automation_batch_alias_target_invalid", "plan.commands.0.as"],
    [plan([add("a", 0, tool("a"), "$future"), add("future", 1)]),
      "automation_batch_alias_unknown", "plan.commands.0.mutation.parentSequenceId"],
    [plan([add("a", 0), { mutation: { kind: "update_node", nodeId: "$a", patch: { prompt: "א".repeat(17000) } } }]),
      "automation_batch_too_large", "plan"],
  ])("rejects malformed or out-of-bounds plans without writes (%s)", async (input, code, path) => {
    const f = fixture();
    await expect(f.drafts.createPlan("Invalid", input)).rejects.toMatchObject({ code, path });
    expect(f.commits()).toBe(0);
    expect(f.read().drafts).toEqual([]);
  });
});
