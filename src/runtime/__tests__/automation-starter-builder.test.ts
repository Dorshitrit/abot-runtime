import { describe, expect, test } from "vitest";
import { buildStarterDefinition } from "../automations/starter-template-builder.js";
import type { AutomationStarter, StarterAgentStep, StarterStep } from "../automations/starter-template-contracts.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { resolveAutomationBinding } from "../automations/binding-resolution.js";
import type { AgentNode, ParallelNode } from "../automations/definition-contracts.js";

function agent(key: string, sources: string[] = []): StarterAgentStep {
  return { kind: "agent", key, title: key, role: "Analyze supplied inputs", prompt: "Return analysis", sources };
}

function build(steps: readonly StarterStep[], inputs: AutomationStarter["inputs"] = {}) {
  return buildStarterDefinition({ id: "test", title: "Test", category: "Test", description: "",
    setup: "", objective: "Test bindings", steps, inputs },
  createEmptyAutomationDefinition("test", "Test"), () => undefined);
}

describe("starter graph materialization", () => {
  test("rejects sibling-branch and forward references instead of relying on branch completion order", () => {
    expect(() => build([{ kind: "parallel", key: "fork", branches: [
      [agent("left")], [agent("right", ["left"])],
    ] }])).toThrow("automation_template_invalid");
    expect(() => build([agent("consumer", ["later"]), agent("later")]))
      .toThrow("automation_template_invalid");
  });

  test("allows shared earlier results in each branch and exposes their outputs only after the join", () => {
    const draft = build([agent("shared"), { kind: "parallel", key: "fork", branches: [
      [agent("left", ["shared"])], [agent("right", ["shared"])],
    ] }, { ...agent("joined", ["left", "right"]), parallelSources: ["fork"] }]);
    const [shared, fork, joined] = draft.body.children as [AgentNode, ParallelNode, AgentNode];
    for (const branch of fork.branches) expect((branch.children[0] as AgentNode).inputs.shared)
      .toEqual({ kind: "node_result", nodeId: shared.id, select: "text" });
    expect(joined.inputs.fork).toEqual({ kind: "branch_results", parallelNodeId: fork.id });
    expect(joined.inputs.left).toEqual({ kind: "node_result", nodeId: fork.branches[0]!.children[0]!.id, select: "text" });
    expect(joined.inputs.right).toEqual({ kind: "node_result", nodeId: fork.branches[1]!.children[0]!.id, select: "text" });
  });

  test("rejects duplicate keys, missing run inputs and missing parallel groups", () => {
    expect(() => build([agent("duplicate"), agent("duplicate")])).toThrow("automation_template_invalid");
    expect(() => build([{ ...agent("reader"), runInputs: ["missing"] }])).toThrow("automation_template_invalid");
    expect(() => build([{ ...agent("reader"), parallelSources: ["missing"] }])).toThrow("automation_template_invalid");
  });

  test("binds updated run inputs by key without leaking unrelated run or node data", () => {
    const draft = build([{ ...agent("reader"), runInputs: ["selected_path"] }], { selected_path: "first.md" });
    const reader = draft.body.children[0] as AgentNode;
    expect(Object.keys(reader.inputs)).toEqual(["selected_path"]);
    const context = { runInputs: { selected_path: "second.md", unrelated: "private" },
      sourceFiles: [], nodeResults: new Map(), branchResults: new Map() };
    expect(resolveAutomationBinding(reader.inputs.selected_path!, context))
      .toEqual({ ok: true, value: "second.md" });
    expect(resolveAutomationBinding(reader.inputs.selected_path!, { ...context, runInputs: {} }))
      .toEqual({ ok: false, code: "automation_dependency_missing" });
  });

  test("materializations do not share mutable inputs or identifiers", () => {
    const inputs = { options: { subject: "first" } };
    const first = build([agent("one")], inputs);
    (first.inputs.options as Record<string, string>).subject = "changed";
    const second = build([agent("one")], inputs);
    expect(second.inputs.options).toEqual({ subject: "first" });
    expect(first.body.children[0]!.id).not.toBe(second.body.children[0]!.id);
  });
});
