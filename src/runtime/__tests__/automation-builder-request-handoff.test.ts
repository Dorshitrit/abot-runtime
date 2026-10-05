import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../model-gateway/types.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { resolveAutomationBinding } from "../automations/binding-resolution.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];
const prompt = "Create a draft that searches, summarizes the search results, and saves each summary to a new run file. Do not run it.";
const answer = "The connected draft is saved for your review.";
const createAssignment = "Save the connected search, summary and per-run file workflow.";
const updateAssignment = "Update the objective to require a new researched summary for every run.";
const correctionAssignment = "Correct the rejected parent reference and save the complete connected workflow.";
const operation = (toolName: string, operationId: string) => ({ toolName, operationId, contractVersion: 1 });
const createPlan = {
  version: 1,
  commands: [
    { as: "search", mutation: { kind: "add_node", parentSequenceId: "$root", index: 0,
      nodeWithoutId: { kind: "tool", title: "Search", onFailure: "stop",
        operation: operation("web_search", "search_many"),
        controls: { queries: { kind: "literal", value: ["Recent technology"] } } } } },
    { as: "summary", mutation: { kind: "add_node", parentSequenceId: "$root", index: 1,
      nodeWithoutId: { kind: "agent", title: "Summarize", onFailure: "stop",
        modelProfileId: "scheduled-model", agentMode: "fast", roleInstructions: "Summarize supplied evidence.",
        prompt: "Write a short summary of the supplied sources.",
        inputs: { sources: { kind: "node_result", nodeId: "$search", select: "text" } },
        tools: [], result: { kind: "text" } } } },
    { as: "save", mutation: { kind: "add_node", parentSequenceId: "$root", index: 2,
      nodeWithoutId: { kind: "tool", title: "Save", onFailure: "stop",
        operation: operation("write_file", "write_complete_file"),
        controls: { path: { kind: "run_file", fileName: "summary.txt" } },
        payload: { kind: "node_result", nodeId: "$summary", select: "text" } } } },
  ],
};

type Receipt = { automationId: string; revision: number; aliases: Record<string, string> };

function toolReceipt(messages: readonly ChatMessage[]): Receipt {
  const settled = [...messages].reverse().find((message) => message.role === "tool");
  if (!settled) throw new Error(`missing_builder_continuation:${messages.at(-1)?.content.slice(0, 1_200)}`);
  const envelope = JSON.parse(settled.content);
  expect(envelope).toMatchObject({ authority: "capability_adapter_result",
    presenceEffect: "runtime_result_only_not_user_intent" });
  const adapterResult = envelope.result.adapterResult;
  expect(adapterResult.result.data).toEqual({ mutationEvidence: true, currentStateEvidence: true });
  expect(adapterResult, JSON.stringify(adapterResult)).toMatchObject({ kind: "registered_tool_execution_result_v1", result: { ok: true } });
  return JSON.parse(adapterResult.result.output) as Receipt;
}

async function request(fixture: Fixture, text: string, requestId: string) {
  const events: Record<string, unknown>[] = [];
  await fixture.application.requests.handle({ send(value: string) {
    events.push(JSON.parse(value));
  } } as unknown as WebSocket, {
    type: "run_request", requestId, sessionId: "session", text,
    agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" },
    toolPermissionMode: "full_access",
  });
  return events;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe("automation builder request handoff", () => {
  it.each(["Save the requested connected draft.", "Preparing the workflow for your review."])(
    "authors the exact connected assignment with presentation %s", async (intent) => {
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    const service = fixture.application.services.automations!;
    const phases: string[] = [];
    let activation = 0;
    let created: Receipt | undefined;
    fixture.invoke.mockImplementation(async (input) => {
      const messages = input.messages as readonly ChatMessage[];
      phases.push(String(input.modelStep));
      if (input.modelStep === "tool_payload.raw") {
        expect(input.format).toMatchObject({ type: "json_schema", name: "automation_draft_plan",
          strict: false, schema: { type: "object", additionalProperties: false } });
        const source = messages.find((message) => message.content.startsWith('{"kind":"runtime_request_source_v1"'));
        expect(JSON.parse(source!.content)).toMatchObject({ authority: "reference_data", currentRequest: prompt });
        const canonical = messages.find((message) => message.content.startsWith("Canonical runtime context:\n"));
        const assignment = JSON.parse(canonical!.content.slice("Canonical runtime context:\n".length));
        expect(assignment.acceptedCapability).toMatchObject({
          capabilityId: created ? "apply_automation_draft_changes" : "create_automation_draft",
          authoringObjective: created ? updateAssignment : createAssignment,
          controls: created ? { automationId: created.automationId, expectedRevision: 1 } : { title: "Connected authoring" },
        });
        expect(assignment.acceptedCapability).not.toHaveProperty("intent");
        expect(JSON.stringify(assignment)).not.toContain(intent);
        const payload = created ? { version: 1, commands: [{ mutation: {
          kind: "update_definition", patch: { objective: "A new researched summary for every run." },
        } }] } : createPlan;
        return { text: JSON.stringify(payload), meta: {} };
      }
      expect(messages.filter((message) => message.role === "user" && message.content === prompt)).toHaveLength(1);
      if (input.modelStep === "execution.response") return { text: answer, meta: {} };
      expect(input.modelStep).toBe("execution.decision");
      activation += 1;
      if (activation === 1) return { text: JSON.stringify({ decision: {
        action: "open_capability_scope", catalogGroupIds: ["automations"],
        acknowledgement: "I will build and save the connected draft.",
      } }), meta: {} };
      if (activation === 2) return { text: JSON.stringify({ decision: {
        action: "invoke_capability", capabilityId: "create_automation_draft",
        operationObjective: createAssignment,
        intent, selectionControls: { title: "Connected authoring" },
        workingDirectory: ".",
      } }), meta: {} };
      if (activation === 3) {
        created = toolReceipt(messages);
        expect(created.revision).toBe(1);
        expect(created.aliases).toEqual(expect.objectContaining({
          search: expect.any(String), summary: expect.any(String), save: expect.any(String),
        }));
        const draft = await service.getDraft(created.automationId);
        expect(draft?.definition.body.children).toHaveLength(3);
        return { text: JSON.stringify({ decision: {
          action: "invoke_capability", capabilityId: "apply_automation_draft_changes",
          operationObjective: updateAssignment,
          intent: "Add the requested objective to this same draft.",
          selectionControls: { automationId: created.automationId, expectedRevision: created.revision },
        } }), meta: {} };
      }
      expect(activation).toBe(4);
      const updated = toolReceipt(messages);
      expect(updated.automationId).toBe(created!.automationId);
      expect(updated.revision).toBe(2);
      return { text: JSON.stringify({ decision: { action: "respond" } }), meta: {} };
    });

    const events = await request(fixture, prompt, "builder-handoff");
    expect(created, JSON.stringify({ phases, terminal: events.at(-1) })).toBeDefined();
    expect(phases).toEqual([
      "execution.decision", "execution.decision", "tool_payload.raw", "execution.decision",
      "tool_payload.raw", "execution.decision", "execution.response",
    ]);
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    const completions = events.filter((event) => event.name === "tool.completed" &&
      event.tool === "automation_builder");
    expect(completions).toEqual([
      expect.objectContaining({ ok: true, meta: expect.objectContaining({
        automationAction: "create_automation_draft", automationTitle: "Connected authoring",
        outputPreview: expect.stringContaining(created!.automationId),
      }) }),
      expect.objectContaining({ ok: true, meta: expect.objectContaining({
        automationAction: "apply_automation_draft_changes", automationId: created!.automationId,
        expectedRevision: 1, outputPreview: expect.stringContaining(created!.automationId),
      }) }),
    ]);
    const draft = (await service.getDraft(created!.automationId))!;
    expect(draft.revision).toBe(2);
    expect(draft.definition.objective).toBe("A new researched summary for every run.");
    const compiled = compileAutomationGraph(draft.definition);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("expected_connected_graph");
    expect(compiled.graph.steps.map(({ dependsOn }) => dependsOn)).toEqual([
      [], [created!.aliases.search], [created!.aliases.summary],
    ]);
    const summary = compiled.graph.steps[1]!.node;
    const save = compiled.graph.steps[2]!.node;
    if (summary.kind !== "agent" || save.kind !== "tool") throw new Error("unexpected_step_kind");
    const evidence = { runInputs: {}, sourceFiles: [], branchResults: new Map(), nodeResults: new Map([
      [created!.aliases.search!, { status: "succeeded" as const, text: "Observed sources" }],
      [created!.aliases.summary!, { status: "succeeded" as const, text: "The actual summary" }],
    ]) };
    expect(resolveAutomationBinding(summary.inputs.sources!, evidence)).toEqual({ ok: true, value: "Observed sources" });
    expect(resolveAutomationBinding(save.payload!, evidence)).toEqual({ ok: true, value: "The actual summary" });
    expect(await service.getGrant(created!.automationId)).toBeNull();
    expect(await fixture.scheduler.getAutomationJob(created!.automationId)).toBeNull();
    expect(await service.listRuns(created!.automationId)).toEqual([]);
    const session = await fixture.application.services.sessions.getSessionById("session");
    expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", content: answer });
  });

  it("returns a rejected batch to the root before an explicit model-selected correction", async () => {
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    const service = fixture.application.services.automations!;
    const malformedPlan = structuredClone(createPlan);
    const malformedMutation = malformedPlan.commands[0]!.mutation as Record<string, unknown>;
    malformedMutation.parentSequenceId = "$missing";
    const phases: string[] = [];
    let activation = 0;
    let payloadCount = 0;
    let created: Receipt | undefined;
    let rootObservedRejection = false;
    fixture.invoke.mockImplementation(async (input) => {
      const messages = input.messages as readonly ChatMessage[];
      phases.push(String(input.modelStep));
      if (input.modelStep === "tool_payload.raw") {
        expect(input.format).toMatchObject({ type: "json_schema", name: "automation_draft_plan",
          strict: false, schema: { type: "object", additionalProperties: false } });
        payloadCount += 1;
        expect(await service.list()).toEqual([]);
        const canonical = messages.find((message) => message.content.startsWith("Canonical runtime context:\n"));
        const assignment = JSON.parse(canonical!.content.slice("Canonical runtime context:\n".length));
        expect(assignment.acceptedCapability).toMatchObject({
          capabilityId: "create_automation_draft", controls: { title: "Corrected authoring" },
        });
        if (assignment.acceptedCapability.authoringObjective === createAssignment)
          return { text: JSON.stringify(malformedPlan), meta: {} };
        expect(assignment.acceptedCapability.authoringObjective).toBe(correctionAssignment);
        expect(payloadCount).toBe(2);
        expect(rootObservedRejection).toBe(true);
        expect(activation).toBe(3);
        return { text: JSON.stringify(createPlan), meta: {} };
      }
      expect(messages.filter((message) => message.role === "user" && message.content === prompt)).toHaveLength(1);
      if (input.modelStep === "execution.response") return { text: answer, meta: {} };
      expect(input.modelStep).toBe("execution.decision");
      activation += 1;
      if (activation === 1) return { text: JSON.stringify({ decision: {
        action: "open_capability_scope", catalogGroupIds: ["automations"],
        acknowledgement: "I will build and save the connected draft.",
      } }), meta: {} };
      if (activation === 2) return { text: JSON.stringify({ decision: {
        action: "invoke_capability", capabilityId: "create_automation_draft",
        operationObjective: createAssignment,
        intent: "Save the requested connected draft.", selectionControls: { title: "Corrected authoring" },
        workingDirectory: ".",
      } }), meta: {} };
      if (activation === 3) {
        expect(payloadCount).toBe(1);
        expect(await service.list()).toEqual([]);
        const settled = messages.filter((message) => message.role === "tool");
        expect(settled).toHaveLength(1);
        const envelope = JSON.parse(settled[0]!.content);
        expect(envelope).toMatchObject({ authority: "capability_adapter_result",
          presenceEffect: "runtime_result_only_not_user_intent" });
        const adapterResult = envelope.result.adapterResult;
        expect(adapterResult).toMatchObject({ kind: "registered_tool_execution_result_v1",
          result: { ok: false, producedNewInformation: false, data: { mutationEvidence: false } } });
        expect(JSON.parse(adapterResult.result.output)).toMatchObject({
          code: "automation_batch_alias_unknown", path: "plan.commands.0.mutation.parentSequenceId",
        });
        rootObservedRejection = true;
        return { text: JSON.stringify({ decision: {
          action: "invoke_capability", capabilityId: "create_automation_draft",
          operationObjective: correctionAssignment,
          intent: "Correct the rejected parent reference and save the same connected graph.",
          selectionControls: { title: "Corrected authoring" },
        } }), meta: {} };
      }
      expect(activation).toBe(4);
      expect(messages.filter((message) => message.role === "tool")).toHaveLength(2);
      created = toolReceipt(messages);
      expect(created.revision).toBe(1);
      return { text: JSON.stringify({ decision: { action: "respond" } }), meta: {} };
    });

    const events = await request(fixture, prompt, "builder-rejection-handoff");
    expect(created, JSON.stringify({ phases, terminal: events.at(-1) })).toBeDefined();
    expect(phases).toEqual([
      "execution.decision", "execution.decision", "tool_payload.raw", "execution.decision",
      "tool_payload.raw", "execution.decision", "execution.response",
    ]);
    expect(payloadCount).toBe(2);
    expect(await service.list()).toHaveLength(1);
    const draft = (await service.getDraft(created!.automationId))!;
    const compiled = compileAutomationGraph(draft.definition);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("expected_connected_graph");
    expect(compiled.graph.steps.map(({ dependsOn }) => dependsOn)).toEqual([
      [], [created!.aliases.search], [created!.aliases.summary],
    ]);
    expect(draft.revision).toBe(1);
    expect(await service.getGrant(created!.automationId)).toBeNull();
    expect(await fixture.scheduler.getAutomationJob(created!.automationId)).toBeNull();
    expect(await service.listRuns(created!.automationId)).toEqual([]);
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    const session = await fixture.application.services.sessions.getSessionById("session");
    expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", content: answer });
  });

  it("does not author a draft or call a payload model for an unrelated request", async () => {
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    await request(fixture, "Say hello.", "unrelated-conversation");
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      "execution.decision", "execution.response",
    ]);
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    expect(await fixture.application.services.automations!.list()).toEqual([]);
  });
});
