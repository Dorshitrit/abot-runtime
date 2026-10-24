import { afterEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { AutomationService } from "../automations/service.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createAutomationBuilderToolModule } from "../capabilities/automation-builder/tool-module.js";
import { AUTOMATION_BUILDER_PAYLOAD_FORMAT } from "../capabilities/automation-builder/payload-schema.js";
import { readInvalidOutputCapsules } from "./support/invalid-output-request.js";
import { createSchedulerRuntimeFixture, type ScheduledModelInput } from "./support/scheduler-runtime-fixture.js";
import { supervisorFormatName, withSupervisorPreparation } from "./support/supervisor-model-phases.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type Receipt = { automationId: string; revision: number; aliases: Record<string, string> };
type ScriptEntry = { step: string; output: string | ((input: ScheduledModelInput) => string | Promise<string>) };
const fixtures: Fixture[] = [];
const decision = (value: unknown) => JSON.stringify({ decision: value });
const prompt = "Create an inactive draft that observes evidence then summarizes that exact evidence. Save it for my review; do not run it.";
const workerObjective = "Save the complete requested connected draft without executing its future workflow.";
const authoringObjective = "Describe both ordered steps and bind the summary input to the observation result.";
const finalAnswer = "The connected draft is saved for review and has not run.";
const recipe = { version: 1, steps: [
  { key: "observe", kind: "tool", title: "Observe evidence", operation: {
    toolName: "future_observer", operationId: "observe_evidence", contractVersion: 1,
  } },
  { key: "summarize", kind: "agent", title: "Summarize evidence", modelProfileId: "scheduled-model",
    prompt: "Summarize only the supplied evidence.", inputs: {
      evidence: { kind: "node_result", nodeId: "$observe", select: "text" },
    } },
] };

function capsule(input: ScheduledModelInput, kind: string) {
  const result = readInvalidOutputCapsules(input, kind).at(-1);
  expect(result, `missing_capsule:${kind}`).toBeDefined();
  return result!;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

it("preserves the complete delegated role chain around one schema-bound draft creation", async () => {
  let service: AutomationService | undefined;
  const executeFutureTool = vi.fn(async () => { throw new Error("future_workflow_must_not_execute"); });
  const registry = createConfiguredToolRegistry(undefined, [
    createAutomationBuilderToolModule(() => {
      if (!service) throw new Error("fixture_service_not_ready");
      return service;
    }, async () => undefined),
    { definition: { name: "future_observer", routingCapability: "filesystem_inspection", catalogGroups: ["evidence"] },
      normalInvocation: { version: 1, operations: [{ operationId: "observe_evidence", summary: "Observe evidence.",
        effect: "read_only", approval: "request_policy",
        input: { type: "object", additionalProperties: false, properties: {}, required: [] },
      }] }, implementation: executeFutureTool },
  ]);
  const fixture = await createSchedulerRuntimeFixture("supervisor-worker-v1", undefined, registry);
  fixtures.push(fixture);
  service = fixture.application.services.automations!;
  const execute = vi.spyOn(registry, "execute");
  let created: Receipt | undefined;
  const workReport = () => `Saved inactive draft ${created!.automationId}, revision ${created!.revision}, with two connected steps. No workflow was executed.`;
  const script: ScriptEntry[] = [
    { step: "supervisor.decision", output: decision({ action: "invoke_role", roleId: "planner",
      objective: "Coordinate creation and review of the requested inactive draft.",
      acknowledgement: "I will build and review the connected draft.",
    }) },
    { step: "supervisor.decision", output: JSON.stringify({ workingDirectory: "." }) },
    { step: "planner.decision", output: decision({ action: "invoke_role", roleId: "worker",
      plan: { summary: "Create the complete draft in one transaction.", items: [
        { title: "Save connected draft", objective: workerObjective },
      ] }, selectedItemIndexes: [0], workerCapabilityScope: { catalogGroupIds: ["automations"] },
    }) },
    { step: "worker.decision", output: (input) => {
      expect(capsule(input, "runtime_worker_assignment")).toMatchObject({ objective: workerObjective });
      return decision({ action: "invoke_capability", capabilityId: "create_automation_draft",
        intent: "Save the connected draft.", authoringObjective, selectionControls: { title: "Delegated draft" },
      });
    } },
    { step: "tool_payload.raw", output: async (input) => {
      expect(input.format).toEqual(AUTOMATION_BUILDER_PAYLOAD_FORMAT);
      const messages = input.messages as readonly ChatMessage[];
      expect(readInvalidOutputCapsules(input, "runtime_request_source_v1")).toEqual([]);
      const prefix = "Canonical runtime context:\n";
      const contextMessage = messages.find(({ content }) => content.startsWith(prefix));
      expect(contextMessage).toBeDefined();
      const context = JSON.parse(contextMessage!.content.slice(prefix.length));
      expect(context).toMatchObject({
        worker: { callId: "call-3", parentCallId: "call-2", objective: workerObjective },
        acceptedCapability: { capabilityId: "create_automation_draft", authoringObjective,
          controls: { title: "Delegated draft" } },
        payloadStage: { index: 1, count: 1, outputParam: "planJson" },
        payloadContract: { responseFormat: AUTOMATION_BUILDER_PAYLOAD_FORMAT },
      });
      expect(context).not.toHaveProperty("root");
      expect(await service!.list()).toEqual([]);
      return JSON.stringify(recipe);
    } },
    { step: "worker.decision", output: async (input) => {
      const results = capsule(input, "runtime_request_tool_results_v1").results;
      expect(results).toHaveLength(1);
      expect(results[0], JSON.stringify(results[0])).toMatchObject({ executionId: "capability-execution-1", callId: "call-3",
        capabilityId: "create_automation_draft", outcome: "succeeded", observedEffect: "mutation",
        adapterResult: { kind: "registered_tool_execution_result_v1", result: { ok: true } },
      });
      created = JSON.parse(results[0].adapterResult.result.output) as Receipt;
      expect(created.revision).toBe(1);
      expect(created.aliases).toEqual(expect.objectContaining({ observe: expect.any(String), summarize: expect.any(String) }));
      expect((await service!.getDraft(created.automationId))?.revision).toBe(created.revision);
      return decision({ action: "return_result" });
    } },
    { step: "worker.result", output: () => workReport() },
    { step: "planner.decision", output: (input) => {
      expect(capsule(input, "runtime_child_result")).toMatchObject({ callerCallId: "call-2", childCallId: "call-3",
        roleId: "worker", outcome: "completed", summary: workReport(),
        workReceipt: { kind: "work_result_v1", producerCallId: "call-3" },
      });
      return decision({ action: "return_result", result: workReport() });
    } },
    { step: "supervisor.decision", output: (input) => {
      expect(capsule(input, "runtime_child_result")).toMatchObject({ callerCallId: "call-1", childCallId: "call-2",
        roleId: "planner", outcome: "completed", summary: workReport(),
        workLineage: { planner: { items: [{ itemId: "plan-call-2-item-1", status: "done" }] } },
      });
      return decision({ action: "invoke_role", roleId: "reviewer" });
    } },
    { step: "reviewer.decision", output: (input) => {
      const audit = capsule(input, "runtime_reviewer_audit_v4");
      expect(audit.dependencySubjects).toEqual([expect.objectContaining({ roleId: "planner",
        outcome: "completed", summary: workReport() })]);
      expect(audit.effects).toHaveLength(1);
      expect(audit.effects[0]).toMatchObject({ evidenceRef: "capability-execution-1", outcome: "succeeded",
        subjectRefs: ["call:call-2"] });
      expect(JSON.stringify(audit)).toContain(created!.automationId);
      return decision({ action: "pass", reviewScopeId: audit.auditScope.reviewScopeId,
        summary: "The requested inactive draft was saved and no future workflow was executed.",
        audit: { evidenceAssessments: [{ evidenceRef: "capability-execution-1", status: "supports",
          finding: "The exact draft creation receipt confirms the single saved revision." }],
        completionAssessment: { status: "satisfied", evidenceRefs: ["capability-execution-1"],
          finding: "The connected draft receipt satisfies the requested authoring outcome." } }, gaps: [],
      });
    } },
    { step: "supervisor.decision", output: (input) => {
      expect(capsule(input, "runtime_child_result")).toMatchObject({ callerCallId: "call-1", childCallId: "call-4",
        roleId: "reviewer", reviewerVerdict: { verdict: "pass" } });
      return decision({ action: "respond" });
    } },
    { step: "supervisor.response", output: finalAnswer },
  ];
  let next = 0;
  let modelAssertion: unknown;
  fixture.invoke.mockImplementation(withSupervisorPreparation(async (input) => {
    try {
      const entry = script[next++];
      expect(entry, `unexpected_model_step:${input.modelStep}`).toBeDefined();
      expect(input.modelStep).toBe(entry!.step);
      const text = typeof entry!.output === "string" ? entry!.output : await entry!.output(input);
      return { text, meta: {} };
    } catch (error) { modelAssertion ??= error; throw error; }
  }));
  const events: Record<string, unknown>[] = [];
  await fixture.application.requests.handle({ send(value: string) { events.push(JSON.parse(value)); } } as unknown as WebSocket, {
    type: "run_request", requestId: "delegated-builder-handoff", sessionId: "session", text: prompt,
    agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" }, toolPermissionMode: "full_access",
  });
  if (modelAssertion) throw modelAssertion;
  expect(events.filter(({ type }) => type === "failed")).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: "completed", output: finalAnswer }));
  expect(next).toBe(script.length);
  expect(fixture.invoke.mock.calls.map(([input]) => supervisorFormatName(input) ?? input.modelStep)).toEqual([
    "supervisor_presentation", "supervisor_procedure_gate", "supervisor_delegation", "supervisor_working_directory",
    "planner.decision", "worker.decision", "tool_payload.raw", "worker.decision", "worker.result",
    "planner.decision", "supervisor_decision", "reviewer.decision", "supervisor_decision", "supervisor.response",
  ]);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toMatchObject({ tool: "automation_builder", params: {
    action: "create_automation_draft", title: "Delegated draft",
  } });
  expect(executeFutureTool).not.toHaveBeenCalled();
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
  expect(created).toBeDefined();
  const draft = (await service.getDraft(created!.automationId))!;
  expect(draft.revision).toBe(1);
  const compiled = compileAutomationGraph(draft.definition);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error("fixture_graph_invalid");
  expect(compiled.graph.steps.map(({ dependsOn }) => dependsOn)).toEqual([[], [created!.aliases.observe]]);
  expect(compiled.graph.steps[1]!.node).toMatchObject({ inputs: {
    evidence: { kind: "node_result", nodeId: created!.aliases.observe, select: "text" },
  } });
  expect(await service.list()).toHaveLength(1);
  expect(await service.getGrant(created!.automationId)).toBeNull();
  expect(await service.listRuns(created!.automationId)).toEqual([]);
  expect(await fixture.scheduler.getAutomationJob(created!.automationId)).toBeNull();
  const session = await fixture.application.services.sessions.getSessionById("session");
  expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", content: finalAnswer });
});
