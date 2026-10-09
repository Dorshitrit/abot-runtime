import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { PUBLIC_PLUGIN_IDS } from "../../../scripts/public-snapshot/contracts.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import type { AgentNode, ToolNode, WorkflowNode } from "../automations/definition-contracts.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { resolveAutomationBinding, type AutomationBindingContext } from "../automations/binding-resolution.js";
import { AUTOMATION_STARTERS } from "../automations/starter-template-definitions.js";
import { listAutomationStarters, prepareAutomationStarter } from "../automations/starter-templates.js";
import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/validator.js";

function publicOperations(): AutomationCatalogOperation[] {
  return PUBLIC_PLUGIN_IDS.flatMap((pluginName) => {
    const manifest = JSON.parse(readFileSync(resolve("plugins", pluginName, "plugin.json"), "utf8"));
    const runtime = manifest.extensions["ai.abot.runtime"];
    return Object.entries(runtime.capabilities).flatMap(([toolName, value]) => {
      const capability = value as { operations?: Record<string, any>; requiredPermissionMode?: "full_access" | "full_plus" };
      return Object.entries(capability.operations || {}).map(([operationId, operation]) => ({
        toolName, operationId, pluginName, contractVersion: 1, catalogGroups: [],
        permissionMode: capability.requiredPermissionMode ?? "full_access",
        label: operation.summary, input: operation.input,
        effect: operation.effect, approval: operation.approval,
        ...(operation.payload ? { payload: operation.payload } : {}),
      }));
    });
  });
}
const operations = publicOperations();
const EXPECTED_PUBLIC_RECIPE_IDS = [
  "code-handoff",
  "document-brief",
  "document-comparison",
  "json-review",
  "local-search-brief",
  "machine-health",
  "project-map",
  "research-studio",
  "source-comparison",
  "web-research",
];

function definition(id: string, available = operations) {
  return prepareAutomationStarter(id, available).buildDefinition(createEmptyAutomationDefinition("automation", "New automation"));
}

function bindings(node: WorkflowNode) {
  if (node.kind === "agent") return Object.values(node.inputs);
  if (node.kind === "tool") return [...Object.values(node.controls), ...(node.payload ? [node.payload] : [])];
  return [];
}

function selectedModel(node: WorkflowNode): WorkflowNode {
  if (node.kind === "sequence") return { ...node, children: node.children.map(selectedModel) };
  if (node.kind === "parallel") return { ...node, branches: node.branches.map((branch) =>
    ({ ...branch, children: branch.children.map(selectedModel) })) };
  return node.kind === "agent" ? { ...node, modelProfileId: "chosen-by-user" } : node;
}

function configuredDefinition(id: string) {
  const draft = definition(id);
  return { ...draft, body: { ...draft.body, children: draft.body.children.map(selectedModel) } };
}

function resultContext(): AutomationBindingContext {
  return { runId: "run-one", runInputs: {}, sourceFiles: [], nodeResults: new Map(), branchResults: new Map() };
}

describe("public Studio starter recipes", () => {
  test("defines only public recipes before catalog filtering or display limits", () => {
    expect(AUTOMATION_STARTERS.map(({ id }) => id).sort()).toEqual(EXPECTED_PUBLIC_RECIPE_IDS);
  });

  test("offers seven small and three advanced recipes using only public installed contracts", () => {
    const cards = listAutomationStarters(operations);
    expect(cards.map((card) => card.id).sort()).toEqual(EXPECTED_PUBLIC_RECIPE_IDS);
    expect(cards.length).toBeLessThanOrEqual(10);
    expect(cards.filter((card) => card.level === "starter")).toHaveLength(7);
    expect(cards.filter((card) => card.level === "advanced").map((card) => card.id).sort())
      .toEqual(["document-comparison", "project-map", "research-studio"]);
    for (const card of cards) {
      expect(card.stepCount).toBeGreaterThanOrEqual(2);
      expect(card.stepCount).toBeLessThanOrEqual(12);
      const draft = definition(card.id);
      expect(draft.trigger).toEqual({ kind: "manual" });
      expect(draft).not.toHaveProperty("source");
      const compilation = compileAutomationGraph(configuredDefinition(card.id));
      expect(compilation).toMatchObject({ ok: true });
      if (!compilation.ok) throw new Error(JSON.stringify(compilation.issues));
      expect(compilation.graph.steps).toHaveLength(card.stepCount);
      expect(compilation.graph.parallelGroups).toHaveLength(card.parallelGroupCount);
      const configuredSteps = compilation.graph.steps.map((step) => step.node);
      expect(configuredSteps.filter((step) => step.kind === "agent")).toHaveLength(card.agentCount);
      // Before model selection, the original draft should fail only for unset model profiles.
      const unconfigured = compileAutomationGraph(draft);
      expect(unconfigured.ok).toBe(false);
      if (!unconfigured.ok) expect(new Set(unconfigured.issues.map((issue) => issue.code)))
        .toEqual(new Set(["automation_model_unavailable"]));
      for (const step of configuredSteps) {
        for (const binding of bindings(step)) {
          if (binding.kind !== "node_result") continue;
          expect(binding.select).toBe("text");
        }
        if (step.kind === "agent") expect(step).toMatchObject({ tools: [], result: { kind: "text" } });
        if (step.kind === "tool") expect(operations.some((operation) =>
          operation.toolName === step.operation.toolName && operation.operationId === step.operation.operationId)).toBe(true);
      }
    }
  });

  test("keeps separately chosen sources distinct even when both use the same operation", () => {
    const [first, second, comparison] = definition("source-comparison").body.children as [ToolNode, ToolNode, AgentNode];
    expect(first.operation).toEqual(second.operation);
    expect(first.id).not.toBe(second.id);
    expect(first.controls).toEqual({});
    expect(second.controls).toEqual({});
    expect(comparison.inputs).toEqual({
      first_page: { kind: "node_result", nodeId: first.id, select: "text" },
      second_page: { kind: "node_result", nodeId: second.id, select: "text" },
    });
    const another = definition("source-comparison");
    expect(another.body.children.map((node) => node.id)).not.toEqual([first.id, second.id, comparison.id]);
  });

  test.each(["web-research", "document-brief"])("%s binds the exact authored body and saves separately for each run", (id) => {
    const [source, author, save] = definition(id).body.children as [ToolNode, AgentNode, ToolNode];
    expect(save.operation).toMatchObject({ toolName: "write_file", operationId: "write_complete_file" });
    expect(save.payload).toEqual({ kind: "node_result", nodeId: author.id, select: "text" });
    expect(save.controls.path?.kind).toBe("run_file");
    const context = resultContext();
    const nodeResults = new Map([
      [source.id, { status: "succeeded" as const, text: "Original source material" }],
      [author.id, { status: "succeeded" as const, text: "# Exact authored note\nNo second author." }],
      ["unrelated", { status: "succeeded" as const, text: "Unrelated material" }],
    ]);
    expect(resolveAutomationBinding(save.payload!, { ...context, nodeResults }))
      .toEqual({ ok: true, value: "# Exact authored note\nNo second author." });
    const first = resolveAutomationBinding(save.controls.path!, context);
    const second = resolveAutomationBinding(save.controls.path!, { ...context, runId: "run-two" });
    expect(first).toMatchObject({ ok: true, value: expect.stringContaining("automation-output/run-one/") });
    expect(second).toMatchObject({ ok: true, value: expect.stringContaining("automation-output/run-two/") });
    expect(first).not.toEqual(second);
    nodeResults.delete(author.id);
    expect(resolveAutomationBinding(save.payload!, { ...context, nodeResults }))
      .toEqual({ ok: false, code: "automation_dependency_missing" });
  });

  test("requires every dependency and preserves unaffected cards when an operation is removed", () => {
    const filtered = operations.filter((operation) => operation.toolName !== "write_file");
    const ids = listAutomationStarters(filtered).map((card) => card.id);
    expect(ids).not.toContain("web-research");
    expect(ids).not.toContain("document-brief");
    expect(ids).not.toContain("document-comparison");
    expect(ids).not.toContain("project-map");
    expect(ids).not.toContain("research-studio");
    expect(ids).toContain("source-comparison");
    expect(ids).toContain("machine-health");
    expect(() => definition("web-research", filtered)).toThrow("automation_template_unavailable");
  });

  test.each(["full_plus", "wrong_effect", "missing_payload", "missing_path", "interactive_approval"])(
    "rejects a saving recipe when its write contract becomes %s", (change) => {
      const changed = operations.map((operation): AutomationCatalogOperation => {
        if (operation.toolName !== "write_file") return operation;
        if (change === "full_plus") return { ...operation, permissionMode: "full_plus" };
        if (change === "wrong_effect") return { ...operation, effect: "read_only" };
        if (change === "missing_payload") { const { payload: _payload, ...without } = operation; return without; }
        if (change === "missing_path") return { ...operation, input: { ...operation.input, properties: {}, required: [] } };
        return { ...operation, approval: "always" };
      });
      expect(() => definition("web-research", changed)).toThrow("automation_template_unavailable");
      expect(listAutomationStarters(changed).map((card) => card.id)).toContain("machine-health");
    },
  );

  test("rejects unsupported recipe IDs", () => {
    for (const id of ["fixture-recipe-one", "fixture-recipe-two", "fixture-recipe-three", "fixture-recipe-four", "fixture-recipe-five"])
      expect(() => definition(id)).toThrow("automation_template_unavailable");
  });

  test("normalizes full file reads before combining them with other project evidence", () => {
    const compilation = compileAutomationGraph(configuredDefinition("project-map"));
    if (!compilation.ok) throw new Error(JSON.stringify(compilation.issues));
    const steps = compilation.graph.steps;
    const fileReaders = steps.filter(({ node }) => node.kind === "tool" && node.operation.toolName === "read_file");
    expect(fileReaders).toHaveLength(2);
    for (const reader of fileReaders) {
      const consumers = steps.filter(({ node }) => node.kind === "agent" && Object.values(node.inputs)
        .some((binding) => binding.kind === "node_result" && binding.nodeId === reader.id));
      expect(consumers).toHaveLength(1);
      const consumer = consumers[0]!.node as AgentNode;
      expect(Object.values(consumer.inputs).filter((binding) => binding.kind === "node_result")).toHaveLength(1);
      expect(Object.values(consumer.inputs).some((binding) => binding.kind === "branch_results")).toBe(false);
    }
  });

  test("research finalization retains original ledgers independently of draft and critique summaries", () => {
    const draft = configuredDefinition("research-studio");
    const compilation = compileAutomationGraph(draft);
    if (!compilation.ok) throw new Error(JSON.stringify(compilation.issues));
    const save = draft.body.children.at(-1) as ToolNode;
    const finalTextBinding = save.payload;
    if (finalTextBinding?.kind !== "node_result") throw new Error("expected_final_text_binding");
    const finalizer = compilation.graph.steps.find((step) => step.id === finalTextBinding.nodeId)?.node as AgentNode;
    expect(Object.keys(finalizer.inputs).sort()).toEqual([
      "research_analysis", "research_critique", "research_draft", "research_question",
    ]);
    const analysis = finalizer.inputs.research_analysis;
    if (analysis?.kind !== "branch_results") throw new Error("expected_research_ledgers");
    const group = compilation.graph.parallelGroups.find((item) => item.id === analysis.parallelNodeId)!;
    const ids = group.branches.flat();
    expect(ids).toHaveLength(3);
    const ledgers = ids.map((nodeId, index) => ({
      nodeId, status: "succeeded" as const, resultRef: `result-${index}`,
      text: `Finding ${index + 1}: https://sources.example/${index}\nCoverage: excerpt only.`,
    }));
    const nodeResults = new Map(ledgers.map(({ nodeId, ...result }) => [nodeId, result]));
    for (const name of ["research_draft", "research_critique"]) {
      const binding = finalizer.inputs[name];
      if (binding?.kind !== "node_result") throw new Error("expected_text_binding");
      nodeResults.set(binding.nodeId, { status: "succeeded", resultRef: name, text: `${name} without URLs` });
    }
    nodeResults.set("unrelated", { status: "succeeded", resultRef: "unrelated-result", text: "Unrelated raw source" });
    const branchResults = new Map([
      [group.id, ledgers.map(({ text: _text, ...record }) => record)],
      ["unrelated-group", [{ nodeId: "unrelated", status: "succeeded" as const, resultRef: "unrelated-result" }]],
    ]);
    const context = { ...resultContext(), runInputs: draft.inputs, nodeResults, branchResults };
    const resolvedInputs = Object.fromEntries(Object.entries(finalizer.inputs).map(([name, binding]) => {
      const resolved = resolveAutomationBinding(binding, context);
      if (!resolved.ok) throw new Error(resolved.code);
      return [name, resolved.value];
    }));
    expect(resolvedInputs).toEqual({
      research_analysis: ledgers,
      research_draft: "research_draft without URLs",
      research_critique: "research_critique without URLs",
      research_question: draft.inputs.research_question,
    });
    nodeResults.set(finalizer.id, { status: "succeeded", resultRef: "final-result", text: "# Final sourced brief" });
    expect(resolveAutomationBinding(finalTextBinding, context)).toEqual({ ok: true, value: "# Final sourced brief" });
    nodeResults.delete(ids[0]!);
    expect(resolveAutomationBinding(analysis, context)).toEqual({ ok: false, code: "automation_dependency_missing" });
  });

  test.each(["project-map", "document-comparison", "research-studio"])(
    "%s resolves every explicit binding and saves the exact final text to isolated run files", (id) => {
      const draft = configuredDefinition(id);
      const compilation = compileAutomationGraph(draft);
      if (!compilation.ok) throw new Error(JSON.stringify(compilation.issues));
      const graph = compilation.graph;
      const nodeResults = new Map<string, { status: "succeeded"; text: string }>();
      const branchResults = new Map(graph.parallelGroups.map((group) => [group.id,
        group.branches.flat().map((nodeId) => ({ nodeId, status: "succeeded" as const }))]));
      const context = { ...resultContext(), runInputs: draft.inputs, nodeResults, branchResults };
      const writtenPaths: string[] = [];
      expect(draft.limits.maxModelCallsPerRun).toBe(64);
      for (const { node } of graph.steps) {
        for (const binding of bindings(node)) {
          const resolved = resolveAutomationBinding(binding, context);
          expect(resolved.ok, `${id}: ${node.title} ${JSON.stringify(binding)}`).toBe(true);
          if (binding.kind !== "branch_results") continue;
          const group = graph.parallelGroups.find((item) => item.id === binding.parallelNodeId)!;
          // Summaries only at the join: raw source data is not copied into synthesis again.
          const members = graph.steps.filter((item) => group.branches.flat().includes(item.id));
          expect(members.every((item) => item.node.kind === "agent")).toBe(true);
          expect(members.length).toBeGreaterThanOrEqual(2);
        }
        if (node.kind === "tool") {
          const operation = operations.find((item) => item.toolName === node.operation.toolName &&
            item.operationId === node.operation.operationId)!;
          const values = Object.fromEntries(Object.entries(node.controls).map(([key, binding]) => {
            const resolved = resolveAutomationBinding(binding, context);
            return [key, resolved.ok ? resolved.value : undefined];
          }));
          expect(validateToolNormalInvocationInput({ ...operation, summary: operation.label }, values).ok,
            `${node.title}: ${JSON.stringify(values)}`).toBe(true);
          if (node.payload?.kind === "node_result") {
            expect(resolveAutomationBinding(node.payload, context)).toEqual({ ok: true,
              value: nodeResults.get(node.payload.nodeId)!.text });
            const first = resolveAutomationBinding(node.controls.path!, context);
            const second = resolveAutomationBinding(node.controls.path!, { ...context, runId: "another-run" });
            expect(first).not.toEqual(second);
            expect(node.controls.path!.kind).toBe("run_file");
            if (first.ok) writtenPaths.push(String(first.value));
          }
        }
        nodeResults.set(node.id, { status: "succeeded", text: `Exact output from ${node.id}` });
      }
      expect(writtenPaths.length).toBeGreaterThan(0);
      expect(new Set(writtenPaths).size).toBe(writtenPaths.length);
      for (const name of listAutomationStarters(operations).find((card) => card.id === id)!.toolNames) {
        const withoutTool = operations.filter((operation) => operation.toolName !== name);
        expect(listAutomationStarters(withoutTool).some((card) => card.id === id)).toBe(false);
        expect(() => definition(id, withoutTool)).toThrow("automation_template_unavailable");
      }
    },
  );
});
