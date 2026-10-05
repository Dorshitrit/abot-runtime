import { expect, test, vi } from "vitest";
import type { AgentNode, SequenceNode, ToolNode } from "../automations/definition-contracts.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { createAutomationStepRunner } from "../automations/step-runner.js";
import { readAutomationStepInputs } from "../automations/step-evidence-inputs.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import type { AutomationResultStore } from "../automations/result-store.js";
import type { SettledNodeResult } from "../automations/binding-resolution.js";

function tool(id: string): ToolNode {
  return { kind: "tool", id, title: id, onFailure: "stop",
    operation: { toolName: "source", operationId: "read", contractVersion: 1 }, controls: {} };
}

function sequence(id: string, children: SequenceNode["children"]): SequenceNode {
  return { kind: "sequence", id, children };
}

function fixture() {
  const consumer: AgentNode = { kind: "agent", id: "consumer", title: "Join", onFailure: "stop",
    modelProfileId: "test", agentMode: "fast", roleInstructions: "Use selected results", prompt: "Combine",
    tools: [], result: { kind: "text" }, inputs: {
      outer: { kind: "branch_results", parallelNodeId: "outer" },
      inner: { kind: "branch_results", parallelNodeId: "inner" },
      explicitEarlier: { kind: "node_result", nodeId: "a_load", select: "data" },
    } };
  const draft = createEmptyAutomationDefinition("automation", "Nested joins");
  const definition = { ...draft, body: sequence("root", [
    { kind: "parallel", id: "outer", branches: [
      sequence("first", [tool("a_load"), tool("a_tail")]),
      sequence("second", [{ kind: "parallel", id: "inner", branches: [
        sequence("inner_first", [tool("b_load"), tool("b_tail")]),
        sequence("inner_second", [tool("c_tail")]),
      ] }]),
    ] }, consumer,
  ]) };
  const compiled = compileAutomationGraph(definition);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const state = emptyAutomationJournalState();
  const outputs = new Map<string, unknown>();
  const execution = { id: "run", automationId: "automation", definitionRevision: definition.revision,
    revision: 1, inputIds: [], nodes: compiled.graph.steps.map((step) => ({
      nodeId: step.id, status: "succeeded" as SettledNodeResult["status"], resultRef: `${step.id}_result`,
    })),
  };
  state.executions.push(execution);
  for (const step of compiled.graph.steps) {
    state.results.push({ id: `${step.id}_result`, runId: "run", nodeId: step.id,
      kind: "node_output", storageRef: step.id, digest: "digest", sizeBytes: 10,
      createdAt: "2026-09-30T00:00:00.000Z" });
    outputs.set(`${step.id}_result`, { text: `text:${step.id}`, data: { id: step.id } });
  }
  const results = { read: vi.fn(async (record: { id: string }) => outputs.get(record.id)) } as unknown as AutomationResultStore;
  const executeAgent = vi.fn(async () => ({ status: "succeeded" as const }));
  const runner = createAutomationStepRunner({
    runId: "run", automationId: "automation", definition, graph: compiled.graph,
    persistence: { read: async () => state }, results, tools: {}, executeAgent,
  } as unknown as Parameters<typeof createAutomationStepRunner>[0]);
  return { consumer, definition, state, execution, results, executeAgent,
    graph: compiled.graph, runner, consumerStep: compiled.graph.steps.at(-1)! };
}

const tailIds = ["a_tail", "b_tail", "c_tail"];
function successfulOutput(nodeId: string) {
  return { nodeId, status: "succeeded", resultRef: `${nodeId}_result`,
    text: `text:${nodeId}`, data: { id: nodeId } };
}

test("serial and nested joins supply only terminal outputs to the agent and saved input evidence", async () => {
  const input = fixture();
  expect(input.graph.parallelGroups.find((group) => group.id === "outer")).toEqual({
    id: "outer", branches: [["a_load", "a_tail"], ["b_load", "b_tail", "c_tail"]], tailNodeIds: tailIds,
  });
  await expect(input.runner.run(input.consumerStep, new AbortController().signal))
    .resolves.toEqual({ status: "succeeded" });
  const call = input.executeAgent.mock.calls[0] as unknown as [{ inputs: Record<string, unknown> }];
  const expected = { outer: tailIds.map(successfulOutput),
    inner: ["b_tail", "c_tail"].map(successfulOutput), explicitEarlier: { id: "a_load" } };
  expect(call[0].inputs).toEqual(expected);
  const evidence = await readAutomationStepInputs({ ...input, node: input.consumer, runId: "run" });
  expect(evidence.map((entry) => JSON.parse(entry.preview!.value))).toEqual(Object.values(expected));
  expect(JSON.stringify(call[0].inputs.outer)).not.toContain("a_load");
  expect(JSON.stringify(call[0].inputs)).not.toContain("b_load");
});

test.each(["skipped", "failed", "cancelled", "interrupted"] as const)(
  "a %s tail carries status without leaking its rejected output or earlier branch output", async (status) => {
    const input = fixture();
    input.execution.nodes.find((node) => node.nodeId === "a_tail")!.status = status;
    await input.runner.run(input.consumerStep, new AbortController().signal);
    const call = input.executeAgent.mock.calls[0] as unknown as [{ inputs: { outer: unknown[] } }];
    expect(call[0].inputs.outer).toEqual([
      { nodeId: "a_tail", status, resultRef: "a_tail_result" },
      ...["b_tail", "c_tail"].map(successfulOutput),
    ]);
    const evidence = await readAutomationStepInputs({ ...input, node: input.consumer, runId: "run" });
    expect(JSON.parse(evidence[0]!.preview!.value)).toEqual(call[0].inputs.outer);
  },
);

test("an unsettled tail cannot be replaced by an earlier successful branch result", async () => {
  const input = fixture();
  input.state.executions[0] = { ...input.execution, nodes: input.execution.nodes.map((node) =>
    node.nodeId === "a_tail" ? { nodeId: node.nodeId, status: "pending" } : node) };
  await expect(input.runner.run(input.consumerStep, new AbortController().signal))
    .resolves.toEqual({ status: "failed", errorCode: "automation_dependency_missing" });
  expect(input.executeAgent).not.toHaveBeenCalled();
});
