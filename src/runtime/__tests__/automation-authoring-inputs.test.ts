import { afterEach, describe, expect, it } from "vitest";
import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/validator.js";
import { resolveAutomationBinding, type AutomationBindingContext } from "../automations/binding-resolution.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { findAutomationStep } from "../automations/step-evidence-effects.js";
import { automationDraftToolContract } from "../capabilities/automations/tool-contract.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
const selected = { toolName: "web_search", operationId: "search_many", contractVersion: 1 };
const other = { toolName: "web_search", operationId: "search_one", contractVersion: 1 };

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    await fixture.dispose();
  }
});

async function setup() {
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const service = fixture.application.services.automations!;
  let draft = await service.create("Authoring inputs");
  const nodes = [
    { kind: "tool", title: "Search", onFailure: "stop", operation: selected,
      controls: { existing: { kind: "literal", value: "keep" } } },
    { kind: "agent", title: "Summarize", onFailure: "stop", modelProfileId: "scheduled-model",
      agentMode: "fast", roleInstructions: "Summarize", prompt: "Return the summary",
      inputs: { existing: { kind: "literal", value: "keep" } },
      tools: [{ operation: other, usage: "available" }], result: { kind: "text" } },
    { kind: "tool", title: "Next tool", onFailure: "stop", operation: selected, controls: {} },
  ];
  for (const [index, nodeWithoutId] of nodes.entries()) {
    draft = await service.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index, nodeWithoutId,
    });
  }
  const module = createAutomationDraftToolModule(() => service, async () => undefined);
  const registry = createConfiguredToolRegistry(undefined, [module]);
  const read = async () => (await service.getDraft(draft.automationId))!;
  const call = async (params: Record<string, unknown>) => registry.execute({ tool: "automations",
    params: { automationId: draft.automationId, expectedRevision: (await read()).revision, ...params } });
  const ids = draft.definition.body.children.map((node) => node.id);
  return { fixture, service, draft, registry, read, call,
    sourceId: ids[0]!, agentId: ids[1]!, toolId: ids[2]! };
}

describe("flat automation input authoring", () => {
  it("authors a complete connected chain using mutation receipts without rereading between edits", async () => {
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    const service = fixture.application.services.automations!;
    const module = createAutomationDraftToolModule(() => service, async () => undefined);
    const registry = createConfiguredToolRegistry(undefined, [module]);
    const actions: string[] = [];
    const invoke = async (action: string, params: Record<string, unknown>) => {
      actions.push(action);
      const result = await registry.execute({ tool: "automations", params: { action, ...params } });
      expect(result.ok, result.error).toBe(true);
      return JSON.parse(result.output) as {
        automationId: string; revision: number; rootSequenceId?: string; newNodeIds?: string[];
      };
    };
    let receipt = await invoke("create_draft", { title: "Research and save" });
    const rootSequenceId = receipt.rootSequenceId!;
    const edit = async (action: string, params: Record<string, unknown>) => {
      const previousRevision = receipt.revision;
      receipt = await invoke(action, { ...params, automationId: receipt.automationId,
        expectedRevision: previousRevision });
      expect(receipt.revision).toBe(previousRevision + 1);
      return receipt;
    };
    const source = await edit("add_tool", { parentSequenceId: rootSequenceId, index: 0,
      title: "Search", onFailure: "stop", ...selected });
    const sourceId = source.newNodeIds![0]!;
    await edit("set_step_literal", { nodeId: sourceId, inputName: "queries", valueJson: '["Technology"]' });
    const agent = await edit("add_agent", { parentSequenceId: rootSequenceId, index: 1,
      title: "Summarize", onFailure: "stop", modelProfileId: "scheduled-model", agentMode: "fast",
      roleInstructions: "Summarize supplied evidence", prompt: "Return summary text" });
    const agentId = agent.newNodeIds![0]!;
    await edit("select_agent_tool", { nodeId: agentId, ...other, usage: "available" });
    await edit("bind_step_result", { nodeId: agentId, inputName: "sources", sourceNodeId: sourceId, select: "text" });
    const output = await edit("add_tool", { parentSequenceId: rootSequenceId, index: 2,
      title: "Save", onFailure: "stop", toolName: "write_file", operationId: "write_complete_file", contractVersion: 1 });
    const outputId = output.newNodeIds![0]!;
    await edit("bind_step_result", { nodeId: outputId, inputName: "content", sourceNodeId: agentId, select: "text" });
    expect(actions).not.toContain("read_draft");

    const current = (await service.getDraft(receipt.automationId))!;
    expect(current.revision).toBe(receipt.revision);
    const compiled = compileAutomationGraph(current.definition);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("expected_compiled_chain");
    expect(compiled.graph.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: sourceId, dependsOn: [] }, { id: agentId, dependsOn: [sourceId] },
      { id: outputId, dependsOn: [agentId] },
    ]);
    const evidence: AutomationBindingContext = { runInputs: {}, sourceFiles: [], branchResults: new Map(),
      nodeResults: new Map([
        [sourceId, { status: "succeeded", text: "Verified source https://example.test/news" }],
        [agentId, { status: "succeeded", text: "Final researched summary" }],
        ["unrelated", { status: "succeeded", text: "Unrelated private content" }],
      ]) };
    const summary = findAutomationStep(current.definition.body, agentId)!;
    const save = findAutomationStep(current.definition.body, outputId)!;
    if (summary.kind !== "agent" || save.kind !== "tool") throw new Error("unexpected_chain_nodes");
    expect(resolveAutomationBinding(summary.inputs.sources!, evidence))
      .toEqual({ ok: true, value: "Verified source https://example.test/news" });
    expect(resolveAutomationBinding(save.controls.content!, evidence))
      .toEqual({ ok: true, value: "Final researched summary" });
    expect(await service.getGrant(receipt.automationId)).toBeNull();
    expect(await fixture.scheduler.getAutomationJob(receipt.automationId)).toBeNull();
  });

  it("preserves legacy input contracts without offering granular edits to the model", async () => {
    const f = await setup();
    const operations = automationDraftToolContract.operations;
    expect(f.registry.listNormalInvocations!()[0]!.contract.operations.map(({ operationId }) => operationId))
      .not.toContain("bind_step_result");
    expect(operations.map((operation) => operation.operationId)).toEqual(expect.arrayContaining([
      "bind_step_result", "set_step_literal", "select_agent_tool",
      "set_agent_inputs", "set_tool_controls", "set_agent_tools", "set_tool_payload",
    ]));
    const bind = operations.find((operation) => operation.operationId === "bind_step_result")!;
    const controls = { automationId: f.draft.automationId, expectedRevision: f.draft.revision,
      nodeId: f.agentId, inputName: "source", sourceNodeId: f.sourceId };
    expect(validateToolNormalInvocationInput(bind, controls).ok).toBe(false);
    expect(validateToolNormalInvocationInput(bind, { ...controls, select: "text" }).ok).toBe(true);
    expect(validateToolNormalInvocationInput(bind, { ...controls, select: "invented" }).ok).toBe(false);
    expect(bind.input.properties).not.toHaveProperty("bindingsJson");
  });

  it("wraps raw JSON arrays and objects as literals without replacing sibling bindings", async () => {
    const f = await setup();
    const queries = ["Technology", "AI", "Cybersecurity"];
    const first = await f.call({ action: "set_step_literal", nodeId: f.sourceId,
      inputName: "queries", valueJson: JSON.stringify(queries) });
    expect(first.ok).toBe(true);
    expect(JSON.parse(first.output)).toEqual({ automationId: f.draft.automationId,
      revision: f.draft.revision + 1, newNodeIds: [] });
    expect(findAutomationStep((await f.read()).definition.body, f.sourceId)).toMatchObject({
      controls: { existing: { kind: "literal", value: "keep" }, queries: { kind: "literal", value: queries } },
    });
    expect((await f.call({ action: "set_step_literal", nodeId: f.agentId,
      inputName: "settings", valueJson: '{"active":true,"limit":3,"fallback":null}' })).ok).toBe(true);
    expect(findAutomationStep((await f.read()).definition.body, f.agentId)).toMatchObject({
      inputs: { existing: { kind: "literal", value: "keep" },
        settings: { kind: "literal", value: { active: true, limit: 3, fallback: null } } },
    });
    expect((await f.call({ action: "set_step_literal", nodeId: f.sourceId,
      inputName: "queries", valueJson: "null" })).ok).toBe(true);
    expect(findAutomationStep((await f.read()).definition.body, f.sourceId)).toMatchObject({
      controls: { existing: { kind: "literal", value: "keep" }, queries: { kind: "literal", value: null } },
    });
  });

  it("binds only the selected prior result, preserving text and data projection intent", async () => {
    const f = await setup();
    expect((await f.call({ action: "bind_step_result", nodeId: f.agentId,
      inputName: "searchResults", sourceNodeId: f.sourceId, select: "text" })).ok).toBe(true);
    expect((await f.call({ action: "bind_step_result", nodeId: f.toolId,
      inputName: "count", sourceNodeId: f.sourceId, select: "data", pointer: "/count" })).ok).toBe(true);
    const current = await f.read();
    expect(findAutomationStep(current.definition.body, f.agentId)).toMatchObject({
      inputs: { existing: { kind: "literal", value: "keep" },
        searchResults: { kind: "node_result", nodeId: f.sourceId, select: "text" } },
    });
    expect(findAutomationStep(current.definition.body, f.toolId)).toMatchObject({
      controls: { count: { kind: "node_result", nodeId: f.sourceId, select: "data", pointer: "/count" } },
    });
    expect(compileAutomationGraph(current.definition).ok).toBe(true);
    expect((await f.call({ action: "bind_step_result", nodeId: f.agentId,
      inputName: "searchResults", sourceNodeId: f.sourceId, select: "text", pointer: "/count" })).ok).toBe(true);
    const invalid = compileAutomationGraph((await f.read()).definition);
    expect(invalid).toMatchObject({ ok: false, issues: expect.arrayContaining([
      expect.objectContaining({ code: "automation_output_pointer_invalid" }),
    ]) });
  });

  it("upserts an exact operation and its usage without granting, publishing or executing", async () => {
    const f = await setup();
    expect((await f.call({ action: "select_agent_tool", nodeId: f.agentId,
      ...selected, usage: "available" })).ok).toBe(true);
    expect((await f.call({ action: "select_agent_tool", nodeId: f.agentId,
      ...selected, usage: "required" })).ok).toBe(true);
    expect((await f.call({ action: "select_agent_tool", nodeId: f.agentId,
      ...selected, contractVersion: 2, usage: "available" })).ok).toBe(true);
    expect(findAutomationStep((await f.read()).definition.body, f.agentId)).toMatchObject({
      tools: [{ operation: other, usage: "available" }, { operation: selected, usage: "required" },
        { operation: { ...selected, contractVersion: 2 }, usage: "available" }],
    });
    expect(await f.service.getGrant(f.draft.automationId)).toBeNull();
    expect(await f.fixture.scheduler.getAutomationJob(f.draft.automationId)).toBeNull();
    expect(await f.service.listRuns(f.draft.automationId)).toEqual([]);
  });

  it("rejects malformed values or missing identities without any draft mutation", async () => {
    const f = await setup();
    const before = await f.read();
    const literal = { action: "set_step_literal", nodeId: f.agentId, inputName: "value", valueJson: "[]" };
    const bind = { action: "bind_step_result", nodeId: f.agentId,
      inputName: "source", sourceNodeId: f.sourceId, select: "text" };
    const invalid = [
      { ...literal, valueJson: "not-json" },
      { ...literal, valueJson: JSON.stringify("א".repeat(2_048)) },
      { ...literal, valueJson: '{"__proto__":{"hidden":true}}' },
      { ...literal, inputName: "invalid input name" },
      { ...literal, nodeId: "missing" },
      { ...literal, nodeId: f.draft.definition.body.id },
      { ...literal, automationId: "missing" },
      { ...bind, sourceNodeId: "missing" },
      { ...bind, select: undefined },
      { ...bind, select: "guess" },
      { action: "select_agent_tool", nodeId: f.toolId, ...selected, usage: "required" },
      { action: "select_agent_tool", nodeId: f.agentId, ...selected, usage: "guess" },
    ];
    for (const params of invalid) {
      expect((await f.call(params)).ok, JSON.stringify(params).slice(0, 120)).toBe(false);
      expect(await f.read()).toEqual(before);
    }
  });

  it("keeps sibling updates atomic under the existing draft revision check", async () => {
    const f = await setup();
    const params = { action: "set_step_literal", nodeId: f.agentId, valueJson: "true",
      expectedRevision: f.draft.revision };
    const results = await Promise.all([
      f.call({ ...params, inputName: "first" }), f.call({ ...params, inputName: "second" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.error).toContain("automation_revision_conflict");
    const current = await f.read();
    expect(current.revision).toBe(f.draft.revision + 1);
    const node = findAutomationStep(current.definition.body, f.agentId)!;
    if (node.kind !== "agent") throw new Error("expected_agent");
    expect(Object.keys(node.inputs)).toHaveLength(2);
    expect(node.inputs.existing).toEqual({ kind: "literal", value: "keep" });
  });

  it("retains the legacy JSON envelope checks and whole-field replacement behavior", async () => {
    const f = await setup();
    const before = await f.read();
    const malformed = [
      { action: "set_agent_tools", nodeId: f.agentId, toolsJson: JSON.stringify([selected]) },
      { action: "set_tool_controls", nodeId: f.sourceId, bindingsJson: '{"queries":["AI"]}' },
      { action: "set_agent_inputs", nodeId: f.agentId,
        bindingsJson: JSON.stringify({ source: { kind: "node_result", nodeId: f.sourceId } }) },
    ];
    for (const params of malformed) {
      expect((await f.call(params)).ok).toBe(false);
      expect(await f.read()).toEqual(before);
    }
    const replacement = { fresh: { kind: "literal", value: 1 } };
    expect((await f.call({ action: "set_agent_inputs", nodeId: f.agentId,
      bindingsJson: JSON.stringify(replacement) })).ok).toBe(true);
    expect(findAutomationStep((await f.read()).definition.body, f.agentId)).toMatchObject({ inputs: replacement });
    const node = findAutomationStep((await f.read()).definition.body, f.agentId)!;
    if (node.kind !== "agent") throw new Error("expected_agent");
    expect(node.inputs).not.toHaveProperty("existing");
  });
});
