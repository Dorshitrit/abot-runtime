import { afterEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createAutomationAgentAssignment } from "../automations/agent-assignment.js";
import type { AgentNode } from "../automations/definition-contracts.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const runtimes: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

function fixture() {
  const definition = { ...createEmptyAutomationDefinition("automation", "Research"),
    objective: "Research the question and save a sourced brief." };
  const node: AgentNode = {
    kind: "agent", id: "synthesis", title: "Synthesize", onFailure: "stop",
    modelProfileId: "model", agentMode: "fast", roleInstructions: "Synthesize the supplied evidence.",
    prompt: "Return a sourced draft as text.", inputs: {}, tools: [], result: { kind: "text" },
  };
  const inputs = { evidence: [{ nodeId: "analysis", status: "succeeded",
    resultRef: "saved-ledger", text: "Finding supported by https://example.test/source" }] };
  return { definition, node, inputs };
}

function assignment(input: Parameters<typeof createAutomationAgentAssignment>[0]) {
  const prompt = createAutomationAgentAssignment(input);
  return { prompt, serialized: prompt.slice(prompt.lastIndexOf("\n\n") + 2) };
}

test("step intent owns the assignment and the workflow objective is passive background", () => {
  const input = fixture();
  const { serialized } = assignment(input);
  const projected = JSON.parse(serialized);
  expect(projected).toMatchObject({ kind: "automation_node_assignment_v2",
    role: input.node.roleInstructions, task: input.node.prompt,
    automationContext: { kind: "automation_background_v1", authority: "reference_only",
      presenceEffect: "does_not_assign_additional_work", objective: input.definition.objective },
    inputs: input.inputs, allowedOperations: [], result: { kind: "text" },
  });
  expect(projected).not.toHaveProperty("objective");
  expect(projected.inputs.evidence).toEqual(input.inputs.evidence);
  expect(serialized.match(/https:\/\/example.test\/source/gu)).toHaveLength(1);
});

test("only explicit step bindings and tool authority are projected", () => {
  const input = fixture();
  const original = assignment(input).prompt;
  const unrelated = { ...input.definition,
    inputs: { unrelated: "Do not introduce a new task." },
    body: { ...input.definition.body, children: [{ ...input.node, id: "unrelated",
      prompt: "Perform another task.", tools: [{ usage: "required" as const,
        operation: { toolName: "other", operationId: "save", contractVersion: 1 } }] }] },
  };
  expect(assignment({ ...input, definition: unrelated }).prompt).toBe(original);
  const selected = { toolName: "reader", operationId: "read", contractVersion: 1 };
  const projected = JSON.parse(assignment({ ...input, node: { ...input.node,
    tools: [{ usage: "required", operation: selected }] } }).serialized);
  expect(projected.allowedOperations).toEqual([{ ...selected, usage: "required" }]);
});

test("explicit new step instructions and bindings remain authoritative", () => {
  const input = fixture();
  const node = { ...input.node, prompt: "Return the new result for the explicit target." };
  const inputs = { target: "/new/location/report.md", text: "New selected evidence" };
  const projected = JSON.parse(assignment({ ...input, node, inputs }).serialized);
  expect(projected.task).toBe(node.prompt);
  expect(projected.inputs).toEqual(inputs);
  expect(projected.inputs).not.toHaveProperty("evidence");
});

test("large structured inputs preserve every source value for shared model admission", () => {
  const input = fixture();
  const inputs = { evidence: "Source evidence ".repeat(3_000),
    finalSource: { title: "מקור אחרון", text: "Unicode evidence 🧪", count: 42 } };
  const { serialized } = assignment({ ...input, inputs });
  expect(serialized.length).toBeGreaterThan(32_768);
  expect(JSON.parse(serialized).inputs).toEqual(inputs);
});

test("the real request path receives one assignment and keeps ordinary requests isolated", async () => {
  const runtime = await createSchedulerRuntimeFixture("execution-agent-v1");
  runtimes.push(runtime);
  const studio = runtime.application.services.automations!;
  const input = fixture();
  let draft = await studio.create("Assignment isolation");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { objective: input.definition.objective,
      inputs: { evidence: input.inputs.evidence } },
  });
  const { id: _id, ...node } = input.node;
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
    nodeWithoutId: { ...node, modelProfileId: "scheduled-model",
      inputs: { evidence: { kind: "run_input", input: "evidence" } } },
  });
  await studio.publish(draft.automationId, draft.revision);
  const run = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(run.id)).status,
    { timeout: 5_000, interval: 10 }).toBe("succeeded");
  const decision = runtime.invoke.mock.calls.find(([call]) => call.modelStep === "execution.decision")![0];
  const messages = decision.messages as ChatMessage[];
  const activeMessages = messages.filter((message) => message.role === "user"
    && JSON.stringify(message.content).includes("automation_node_assignment_v2"));
  expect(activeMessages).toHaveLength(1);
  const modelContext = JSON.stringify(decision.messages);
  expect(modelContext).toContain("automation_background_v1");
  expect(modelContext).toContain(input.node.prompt);
  expect(modelContext).toContain("https://example.test/source");

  runtime.invoke.mockClear();
  await runtime.runOrdinaryRequest("Return an unrelated ordinary answer.", "ordinary-isolation");
  for (const [call] of runtime.invoke.mock.calls) {
    expect(JSON.stringify(call.messages)).not.toContain("automation_node_assignment_v2");
    expect(JSON.stringify(call.messages)).not.toContain("https://example.test/source");
  }
});
