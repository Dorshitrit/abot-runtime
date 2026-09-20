import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import {
  createAuditorRunnerFixture,
  readAuditCapsule,
  auditFormatName,
  auditMessages,
  type AuditRunnerInput,
} from "./support/auditor-runner-fixture.js";
import {
  createTestRequestExecutionScope,
  deriveTestRequestExecutionScope,
} from "./support/request-execution-scope.js";
import { WORK_PLAN_GRAPH } from "./support/model-work-plan-source-fixture.js";

const graph = { ...WORK_PLAN_GRAPH, nodes: WORK_PLAN_GRAPH.nodes.slice(0, 2) };
type RootState = {
  workPlan?: {
    availableProposals: { sourceResultRef: string; itemIds: string[] }[];
    adopted?: {
      sourceResultRef: string;
      items: { itemId: string; status: string }[];
    };
  };
  capabilitySelectionReconsideration?: unknown;
};
const stateOf = (input: AuditRunnerInput) =>
  readAuditCapsule<RootState>(input, "runtime_execution_state_v1");
const report = (
  state: RootState,
  mode: "adopt" | "progress",
  itemUpdates: { itemId: string; status: string }[],
) => ({
  mode,
  sourceResultRef: state.workPlan!.availableProposals[0]!.sourceResultRef,
  itemUpdates,
});
const observe = (path: string, establishDirectory = true) => ({
  action: "invoke_capability",
  capabilityId: "fixture.observe",
  intent: `Inspect ${path}.`,
  selectionControls: { path },
  ...(establishDirectory ? { workingDirectory: "." } : {}),
});
function prelude(index: number) {
  if (index === 1)
    return {
      action: "open_capability_scope",
      catalogGroupIds: ["files"],
      acknowledgement: "I will inspect the requested records.",
    };
  return {
    action: "invoke_planner",
    objective: "Propose the two requested observations.",
  };
}
function planEvents(fixture: ReturnType<typeof createAuditorRunnerFixture>) {
  return vi
    .mocked(fixture.request.onEvent)
    .mock.calls.filter(([name]) => name.startsWith("planner.plan."));
}
function setup(decide: (input: AuditRunnerInput) => unknown) {
  const fixture = createAuditorRunnerFixture(
    (input) => (input.modelStep === "planner.graph" ? graph : decide(input)),
    2,
  );
  const request = deriveTestRequestExecutionScope(fixture.request, {
    prompt: "Inspect both supplied records and report the result.",
    runnerConfig: {
      ...fixture.request.runnerConfig,
      steps: {
        ...fixture.request.runnerConfig.steps,
        "planner.graph": { timeoutMs: 20_000 },
        "capability.controls": { timeoutMs: 20_000 },
      },
    },
  });
  return { ...fixture, request };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("EA model work-plan declarations through the shared request runner", () => {
  test("adopts and reports progress alongside existing actions without extra model turns", async () => {
    let decisions = 0;
    let audits = 0;
    const fixture = setup((input) => {
      if (input.modelStep === "auditor.decision") {
        audits += 1;
        const assignment = readAuditCapsule<{ auditId: string }>(
          input,
          "runtime_execution_agent_auditor_assignment_v1",
        );
        const ids = fixture.records.map((record) => record.executionId);
        const inventory = readAuditCapsule<{
          inventory: { executionId: string }[];
        }>(input, "runtime_execution_agent_auditor_inventory_v1");
        expect(inventory.inventory.map((item) => item.executionId)).toEqual(
          ids,
        );
        expect(JSON.stringify(inventory)).not.toContain("workPlan");
        if (auditFormatName(input) === "auditor_evidence_selection")
          return { auditId: assignment.auditId, selectedEvidenceIds: ids };
        const proof = readAuditCapsule<{
          evidence: { adapterResult: unknown }[];
        }>(input, "runtime_execution_agent_auditor_evidence_v1");
        expect(proof.evidence.map((item) => item.adapterResult)).toEqual(
          fixture.records.map((record) => record.exactResult),
        );
        expect(JSON.stringify(proof)).not.toContain("workPlan");
        return {
          auditId: assignment.auditId,
          verdict: "pass",
          criterionIds: ["request_completion"],
          gaps: [],
          neededEvidenceIds: ids,
          notNeededEvidenceIds: [],
          requestedEvidenceIds: [],
        };
      }
      decisions += 1;
      expect(input.modelStep).toBe("execution.decision");
      if (decisions <= 2) return prelude(decisions);
      const state = stateOf(input);
      if (decisions === 3) {
        expect(state.workPlan?.availableProposals).toEqual([
          { sourceResultRef: "result-1", itemIds: ["write", "verify"] },
        ]);
        expect(state.workPlan).not.toHaveProperty("adopted");
        expect(planEvents(fixture)).toEqual([]);
        return {
          ...observe("record-1.txt"),
          workPlan: report(state, "adopt", [
            { itemId: "write", status: "in_progress" },
          ]),
        };
      }
      if (decisions === 4) {
        expect(state.workPlan?.adopted?.items).toEqual([
          { itemId: "write", status: "in_progress" },
          { itemId: "verify", status: "pending" },
        ]);
        expect(planEvents(fixture).map(([name]) => name)).not.toContain(
          "planner.plan.item.completed",
        );
        return {
          ...observe("record-2.txt", false),
          workPlan: report(state, "progress", [
            { itemId: "write", status: "done" },
            { itemId: "verify", status: "in_progress" },
          ]),
        };
      }
      if (decisions === 5) {
        expect(state.workPlan?.adopted?.items).toEqual([
          { itemId: "write", status: "done" },
          { itemId: "verify", status: "in_progress" },
        ]);
        return {
          action: "invoke_auditor",
          criterionIds: ["request_completion"],
          workPlan: report(state, "progress", [
            { itemId: "verify", status: "done" },
          ]),
        };
      }
      expect(decisions).toBe(6);
      expect(
        state.workPlan?.adopted?.items.every((item) => item.status === "done"),
      ).toBe(true);
      expect(
        auditMessages(input)
          .filter(({ role }) => role === "tool")
          .every(({ content }) => !content.includes("workPlan")),
      ).toBe(true);
      return { action: "respond" };
    });
    const result = await runRequestRunner(fixture.request);
    expect(result.output).toContain("audited");
    expect(decisions).toBe(6);
    expect(audits).toBe(2);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(
      [
        "execution.decision",
        "execution.decision",
        "planner.graph",
        "execution.decision",
        "execution.decision",
        "execution.decision",
        "auditor.decision",
        "auditor.decision",
        "execution.decision",
        "execution.response",
      ],
    );
    expect(planEvents(fixture).map(([name]) => name)).toEqual([
      "planner.plan.created",
      "planner.plan.item.started",
      "planner.plan.item.planned",
      "planner.plan.updated",
      "planner.plan.item.completed",
      "planner.plan.item.started",
      "planner.plan.updated",
      "planner.plan.item.completed",
    ]);
    const responseInput = fixture.invoke.mock.calls.at(-1)![0];
    expect(stateOf(responseInput)).not.toHaveProperty("workPlan");
  });

  test("failed capability and terminal response do not complete the model's active item", async () => {
    let decisions = 0;
    const fixture = setup((input) => {
      decisions += 1;
      if (decisions <= 2) return prelude(decisions);
      const state = stateOf(input);
      if (decisions === 3)
        return {
          ...observe("record-1.txt"),
          workPlan: report(state, "adopt", [
            { itemId: "write", status: "in_progress" },
          ]),
        };
      expect(state.workPlan?.adopted?.items[0]?.status).toBe("in_progress");
      expect(fixture.execute).toHaveBeenCalledTimes(1);
      return { action: "respond" };
    });
    fixture.execute.mockResolvedValueOnce({
      outcome: "failed",
      failureOutcomeFingerprint: null,
      observedEffect: "none",
      summary: "Fixture observation failed.",
      exactResult: {
        kind: "generic_capability_result_v1",
        authority: "capability_adapter",
        status: "executed",
        ok: false,
        payload: { error: "fixture_observation_failed" },
      },
    });
    await runRequestRunner(fixture.request);
    expect(decisions).toBe(4);
    expect(planEvents(fixture).map(([name]) => name)).toEqual([
      "planner.plan.created",
      "planner.plan.item.started",
      "planner.plan.item.planned",
    ]);
  });

  test.each(["before", "after"] as const)(
    "steering %s declaration fences the paired action",
    async (timing) => {
      let decisions = 0;
      const steering = createRequestSteeringInbox({
        requestId: "auditor-evidence-runner",
      });
      const steer = () =>
        steering.append({
          steerId: "fresh-request",
          text: "Stop the observations and respond now.",
        });
      const fixture = setup((input) => {
        decisions += 1;
        if (decisions <= 2) return prelude(decisions);
        const state = stateOf(input);
        if (decisions === 3) {
          if (timing === "before") steer();
          return {
            ...observe("record-1.txt"),
            workPlan: report(state, "adopt", [
              { itemId: "write", status: "in_progress" },
            ]),
          };
        }
        expect(decisions).toBe(4);
        if (timing === "before")
          expect(state.workPlan).not.toHaveProperty("adopted");
        else
          expect(state.workPlan?.adopted?.items[0]?.status).toBe("in_progress");
        return { action: "respond" };
      });
      const request = deriveTestRequestExecutionScope(fixture.request, {
        requestSteering: steering,
        onEvent: (name, payload) => {
          fixture.request.onEvent(name, payload);
          if (timing === "after" && name === "planner.plan.created") steer();
        },
      });
      await runRequestRunner(request);
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(planEvents(fixture)).toHaveLength(timing === "before" ? 0 : 3);
      expect(decisions).toBe(4);
    },
  );

  test("a rejected controls refinement does not adopt the report carried by its original selection", async () => {
    let decisions = 0;
    let refinements = 0;
    const fixture = setup((input) => {
      const isRefinement = auditMessages(input).some(({ content }) =>
        content.includes("runtime_execution_capability_refinement_v1"),
      );
      if (isRefinement) {
        refinements += 1;
        expect(stateOf(input)).not.toHaveProperty("workPlan");
        return {
          invocations: { invocation_1: { unexpected: "invalid controls" } },
        };
      }
      decisions += 1;
      if (decisions <= 2) return prelude(decisions);
      const state = stateOf(input);
      if (decisions === 3)
        return {
          action: "invoke_capability",
          capabilityId: "fixture.observe",
          intent: "Inspect record-1.txt.",
          workingDirectory: ".",
          operationObjective: "Inspect the first requested record.",
          workPlan: report(state, "adopt", [
            { itemId: "write", status: "in_progress" },
          ]),
        };
      expect(state).toHaveProperty("capabilitySelectionReconsideration");
      expect(state.workPlan).not.toHaveProperty("adopted");
      return { action: "respond" };
    });
    const original =
      fixture.request.workerCapabilities.provider.getAdapters()[0]!;
    const descriptor = { ...original.descriptor, selectionControlIds: [] };
    const request = createTestRequestExecutionScope({
      ...fixture.request,
      workerCapabilityProvider: {
        getDescriptors: () => [descriptor],
        getAdapters: () => [{ ...original, descriptor }],
      },
    });
    await runRequestRunner(request);
    expect(refinements).toBeGreaterThan(0);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(planEvents(fixture)).toEqual([]);
    expect(decisions).toBe(4);
  });
});
