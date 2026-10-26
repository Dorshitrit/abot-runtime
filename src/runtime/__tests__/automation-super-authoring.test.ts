import { afterEach, expect, it } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../model-gateway/types.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import type { readAutomationAuthoringCatalogIndex } from "../capabilities/automations/authoring-catalog.js";
import type { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import { completeAuthoringPlan, createCompleteAuthoringFixture } from "./support/automation-complete-authoring-fixture.js";
import { workerEvidenceReply } from "./support/worker-evidence-script.js";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";

type Fixture = Awaited<ReturnType<typeof createCompleteAuthoringFixture>>;
type Catalog = Awaited<ReturnType<typeof readAutomationAuthoringCatalogIndex>>;
type Prepared = Awaited<ReturnType<typeof readAutomationAuthoringPreparation>>;
type Receipt = { automationId: string; revision: number; operationRefs: string[] };
const fixtures: Fixture[] = [];
const prompt = "Create a Studio draft that inventories existing articles, plans up to three research queries, searches, writes one sourced technology article and saves it in a new file. Leave timing and activation to me.";
const objective = "Save and validate one connected five-step Studio draft; do not run, grant or publish it.";
const workerResult = "Saved and validated the connected draft. It remains manual and has no grant or scheduled job.";
const answer = "The connected draft is ready. Set its timing and grant permissions before publishing.";
const wantedOperations = ["search_local_files", "search_many", "write_complete_file"];

function capsule<T>(messages: readonly ChatMessage[], kind: string): T {
  const found = [...messages].reverse().find(({ content }) => content.startsWith(`{"kind":"${kind}"`));
  expect(found, `missing ${kind}`).toBeDefined();
  return JSON.parse(found!.content) as T;
}

function exactReceipt<T>(messages: readonly ChatMessage[], capabilityId: string): T {
  const view = capsule<{ results: { capabilityId: string;
    adapterResult: { result: { output: string } } }[] }>(messages, "runtime_request_tool_results_v1");
  expect(view).toMatchObject({ authority: "reference_data", coverage: { kind: "call", callId: "call-3" } });
  const receipt = view.results.find((result) => result.capabilityId === capabilityId);
  expect(receipt).toMatchObject({ callId: "call-3", outcome: "succeeded",
    adapterResult: { kind: "registered_tool_execution_result_v1", result: { ok: true } } });
  return JSON.parse(receipt!.adapterResult.result.output) as T;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

it("carries scoped catalog evidence through the full SUPER draft-authoring and review chain", async () => {
  const fixture = await createCompleteAuthoringFixture("supervisor-worker-v1");
  fixtures.push(fixture);
  const phases: string[] = [];
  let supervisorTurns = 0;
  let plannerTurns = 0;
  let workerTurns = 0;
  let prepared: Prepared | undefined;
  let created: Receipt | undefined;
  let modelProfileId: string | undefined;
  const savedResult = () => `${workerResult} Automation ${created!.automationId}; revision ${created!.revision}.`;
  const decision = (value: unknown) => ({ text: JSON.stringify({ decision: value }), meta: {} });
  fixture.invoke.mockImplementation(withSupervisorPreparation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    const format = input.format;
    if (typeof format === "object" && format?.name === "supervisor_working_directory")
      return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
    phases.push(String(input.modelStep));
    if (input.modelStep === "supervisor.decision") {
      supervisorTurns += 1;
      expect(messages.filter(({ role, content }) => role === "user" && content === prompt)).toHaveLength(1);
      if (supervisorTurns === 1) return decision({ action: "invoke_role", roleId: "planner",
        objective, acknowledgement: "I will prepare and review the draft without activating it." });
      const returned = capsule(messages, "runtime_child_result");
      if (supervisorTurns === 2) {
        expect(returned).toMatchObject({ callerCallId: "call-1", childCallId: "call-2",
          roleId: "planner", outcome: "completed", summary: savedResult(),
          workLineage: { planner: { items: [{ status: "done" }] } } });
        return decision({ action: "invoke_role", roleId: "reviewer" });
      }
      expect(supervisorTurns).toBe(3);
      expect(returned).toMatchObject({ callerCallId: "call-1", roleId: "reviewer",
        reviewerVerdict: { kind: "reviewer_verdict_v1", verdict: "pass" } });
      return decision({ action: "respond" });
    }
    if (input.modelStep === "planner.decision") {
      plannerTurns += 1;
      if (plannerTurns === 1) return decision({ action: "invoke_role", roleId: "worker",
        plan: { summary: objective, items: [{ title: "Author the connected draft", objective }] },
        selectedItemIndexes: [0], workerCapabilityScope: { catalogGroupIds: ["automations"] } });
      expect(plannerTurns).toBe(2);
      expect(capsule(messages, "runtime_child_result")).toMatchObject({
        callerCallId: "call-2", childCallId: "call-3", roleId: "worker",
        delegatedObjective: objective, outcome: "completed", summary: savedResult(),
        workReceipt: { kind: "work_result_v1", producerCallId: "call-3" },
      });
      return decision({ action: "return_result", result: savedResult() });
    }
    if (input.modelStep === "worker.evidence") {
      const requiresExecution = workerTurns < 4;
      if (!requiresExecution)
        expect(exactReceipt(messages, "validate_draft")).toEqual({ issues: [] });
      return workerEvidenceReply(input, requiresExecution);
    }
    if (input.modelStep === "worker.decision") {
      workerTurns += 1;
      if (workerTurns === 1) return decision({ action: "invoke_capability", capabilityId: "browse_catalog",
        intent: "Discover future workflow operations for the requested draft.", selectionControls: { offset: 0 } });
      if (workerTurns === 2) {
        const catalog = exactReceipt<Catalog>(messages, "browse_catalog");
        expect(catalog.catalogScope).toEqual({ kind: "pre_draft" });
        expect(catalog.permissions).toEqual(AUTOMATION_AUTHORING_REFERENCE.permissions);
        expect(catalog.nextOffset).toBeNull();
        const selected = catalog.operations.items.filter(({ operationId }) => wantedOperations.includes(operationId));
        expect(selected).toHaveLength(3);
        expect(selected.every(({ granted }) => !granted)).toBe(true);
        expect(await fixture.service.list()).toEqual([]);
        modelProfileId = catalog.models.items[0]!.id;
        return decision({ action: "invoke_capability", capabilityId: "prepare_draft",
          intent: "Read only the three selected contracts and authoring reference.",
          selectionControls: { operationRefs: selected.map(({ ref }) => ref) } });
      }
      if (workerTurns === 3) {
        prepared = exactReceipt<Prepared>(messages, "prepare_draft");
        expect(prepared).toMatchObject({ catalogScope: { kind: "pre_draft" },
          grantsPermissions: false, executesWorkflow: false,
          authoringReference: { permissions: AUTOMATION_AUTHORING_REFERENCE.permissions } });
        expect(prepared.operations.map(({ operationId }) => operationId).sort()).toEqual([...wantedOperations].sort());
        return decision({ action: "invoke_capability", capabilityId: "create_automation_draft",
          intent: "Save the requested connected draft.", authoringObjective: objective,
          selectionControls: { title: "Reviewed technology draft" } });
      }
      if (workerTurns === 4) {
        created = exactReceipt<Receipt>(messages, "create_automation_draft");
        expect(created.revision).toBe(1);
        expect([...created.operationRefs].sort()).toEqual(prepared!.operations.map(({ ref }) => ref).sort());
        return decision({ action: "invoke_capability", capabilityId: "validate_draft",
          intent: "Validate the exact saved draft.", selectionControls: { automationId: created.automationId } });
      }
      throw new Error("unexpected_worker_selection_after_validation");
    }
    if (input.modelStep === "tool_payload.raw") {
      expect(prepared).toBeDefined();
      expect(await fixture.service.list()).toEqual([]);
      const prefix = "Canonical runtime context:\n";
      const source = messages.find(({ content }) => content.startsWith(prefix));
      expect(source).toBeDefined();
      const context = JSON.parse(source!.content.slice(prefix.length));
      expect(context).toMatchObject({ worker: { callId: "call-3", parentCallId: "call-2", objective },
        acceptedCapability: { capabilityId: "create_automation_draft", authoringObjective: objective,
          controls: { title: "Reviewed technology draft" } } });
      expect(context).not.toHaveProperty("root");
      const preparation = context.settledCapabilityResults.find(
        (result: { capabilityId: string }) => result.capabilityId === "prepare_draft");
      expect(preparation).toMatchObject({ callId: "call-3", outcome: "succeeded" });
      expect(JSON.parse(preparation.adapterResult.result.output)).toEqual(prepared);
      expect(messages.filter(({ role, content }) => role === "user" && content === prompt)).toHaveLength(0);
      return { text: JSON.stringify(completeAuthoringPlan(modelProfileId!)), meta: {} };
    }
    if (input.modelStep === "worker.result") {
      expect(created).toBeDefined();
      expect(JSON.stringify(messages)).toContain(created!.automationId);
      return { text: savedResult(), meta: {} };
    }
    if (input.modelStep === "reviewer.decision") {
      type Audit = { auditScope: { reviewScopeId: string }; dependencySubjects: unknown[];
        effects: { evidenceRef: string }[] };
      const audit = capsule<Audit>(messages, "runtime_reviewer_audit_v4");
      expect(audit.dependencySubjects).toEqual([expect.objectContaining({
        roleId: "planner", summary: savedResult(), outcome: "completed",
      })]);
      expect(audit.effects.length).toBeGreaterThan(0);
      expect(JSON.stringify(messages)).toContain(created!.automationId);
      return decision({ action: "pass", reviewScopeId: audit.auditScope.reviewScopeId,
        audit: { evidenceAssessments: audit.effects.map(({ evidenceRef }) => ({ evidenceRef,
          status: "supports", finding: "The saved draft and validation receipt establish the requested graph." })),
        completionAssessment: { status: "satisfied", evidenceRefs: audit.effects.map(({ evidenceRef }) => evidenceRef),
          finding: "The draft was saved and validated once without activating the workflow." } },
        summary: "The requested draft exists and validation passed.", gaps: [] });
    }
    expect(input.modelStep).toBe("supervisor.response");
    return { text: answer, meta: {} };
  }));

  const events: Record<string, unknown>[] = [];
  await fixture.application.requests.handle({ send(value: string) { events.push(JSON.parse(value)); } } as unknown as WebSocket, {
    type: "run_request", requestId: "super-automation-authoring", sessionId: "session", text: prompt,
    agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" },
    toolPermissionMode: "full_access",
  });
  expect(events.at(-1), JSON.stringify({ phases, terminal: events.at(-1) })).not.toMatchObject({ type: "failed" });
  expect(phases).toEqual(["supervisor.decision", "planner.decision", "worker.evidence", "worker.decision",
    "worker.evidence", "worker.decision", "worker.evidence", "worker.decision", "tool_payload.raw",
    "worker.evidence", "worker.decision", "worker.evidence", "worker.result",
    "planner.decision", "supervisor.decision", "reviewer.decision", "supervisor.decision", "supervisor.response"]);
  expect(fixture.execute.mock.calls.map(([call]) => call.params.action)).toEqual([
    "browse_catalog", "prepare_draft", "create_automation_draft", "validate_draft",
  ]);
  expect(await fixture.service.list()).toHaveLength(1);
  const draft = (await fixture.service.getDraft(created!.automationId))!;
  expect(draft.revision).toBe(1);
  expect(draft.definition.trigger).toEqual({ kind: "manual" });
  const compiled = compileAutomationGraph(draft.definition);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  expect(compiled.graph.steps.map(({ node }) => node.kind)).toEqual(["tool", "agent", "tool", "agent", "tool"]);
  expect(compiled.graph.steps.map(({ dependsOn }) => dependsOn)).toEqual([
    [], ...compiled.graph.steps.slice(0, -1).map(({ node }) => [node.id]),
  ]);
  expect(await fixture.service.getGrant(created!.automationId)).toBeNull();
  expect(await fixture.scheduler.getAutomationJob(created!.automationId)).toBeNull();
  expect(await fixture.service.listRuns(created!.automationId)).toEqual([]);
  expect(fixture.executeFutureTool).not.toHaveBeenCalled();
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
  const session = await fixture.application.services.sessions.getSessionById("session");
  expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", content: answer });
});
