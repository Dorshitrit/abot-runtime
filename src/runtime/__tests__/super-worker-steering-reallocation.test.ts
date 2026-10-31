import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestCapabilityExecutionView } from "../request/execution-scope.js";
import type { WorkerCapabilityAdapter, WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestSteeringInbox, REQUEST_STEERING_MESSAGE_KIND } from "../request/request-steering.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { runnerConfig, modelPolicy, separateSupervisorRunnerModelPhases } from "./support/supervisor-runner-model-phases.js";
import { workerEvidenceReply } from "./support/worker-evidence-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function capsules(input: Parameters<ModelGatewayClient["invoke"]>[0], kind: string): Record<string, unknown>[] {
  return (input.messages as ChatMessage[]).flatMap(({ content }) => {
    try { const value = JSON.parse(content); return value?.kind === kind ? [value] : []; }
    catch { return []; }
  });
}

function reply(decision: unknown) { return { text: JSON.stringify({ decision }), meta: {} }; }

function capabilityDescriptor(capabilityId: string, group: "read" | "write"): WorkerCapabilityDescriptor {
  return {
    capabilityId, summary: `${group} one bounded artifact.`, catalogGroups: [group],
    effect: group === "read" ? "observation" : "mutation",
    controls: { type: "object", properties: {}, required: [], additionalProperties: false },
    controlsRefinement: "mechanical_when_complete",
  };
}

test("latest steering supersedes a resumed Planner decision and only its fresh Worker receives the new tool allocation", async () => {
  const steering = createRequestSteeringInbox({ requestId: "steering-reallocation" });
  const executeRead = vi.fn<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]>(async () => ({
    outcome: "succeeded", observedEffect: "observation", summary: "Read the original artifact.",
    exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true, payload: { source: "original" } },
  }));
  const executeWrite = vi.fn<WorkerCapabilityAdapter<RequestCapabilityExecutionView>["execute"]>(async () => ({
    outcome: "succeeded", observedEffect: "mutation", summary: "Created the newest artifact.",
    exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true, payload: { artifact: "newest" } },
  }));
  const adapters: readonly WorkerCapabilityAdapter<RequestCapabilityExecutionView>[] = [
    { descriptor: capabilityDescriptor("fixture.read", "read"), execute: executeRead },
    { descriptor: capabilityDescriptor("fixture.write", "write"), execute: executeWrite },
  ];
  let rootDecisions = 0;
  let plannerDecisions = 0;
  let workerDecisions = 0;
  let workerResults = 0;
  const workerCallIds: unknown[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    if (input.modelStep === "supervisor.decision") return reply(++rootDecisions === 1
      ? { action: "invoke_role", roleId: "planner", objective: "Complete the requested artifact work." }
      : { action: "respond" });
    if (input.modelStep === "planner.decision") {
      plannerDecisions += 1;
      if (plannerDecisions === 1) return reply({
        action: "invoke_role", roleId: "worker", workerCapabilityScope: { catalogGroupIds: ["read"] },
        plan: { summary: "Initial work.", items: [{ title: "Original", objective: "Inspect the original artifact." }] },
        selectedItemIndexes: [0],
      });
      const updates = capsules(input, REQUEST_STEERING_MESSAGE_KIND);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        authority: "user", version: plannerDecisions === 2 ? 1 : 2,
        updates: plannerDecisions === 2
          ? [{ sequence: 1, text: "Replace the read task with writing." }]
          : [{ sequence: 1, text: "Replace the read task with writing." }, { sequence: 2, text: "Create only the newest artifact." }],
      });
      if (plannerDecisions === 2) {
        steering.append({ steerId: "newer", text: "Create only the newest artifact." });
        return reply({
          action: "invoke_role", roleId: "worker", workerCapabilityScope: { catalogGroupIds: ["read"] },
          extension: { items: [{ title: "Superseded", objective: "STALE_PLANNER_TARGET" }] }, selectedItemIndexes: [0],
        });
      }
      if (plannerDecisions === 3) return reply({
        action: "invoke_role", roleId: "worker", workerCapabilityScope: { catalogGroupIds: ["write"] },
        extension: { items: [{ title: "Newest", objective: "Create only the newest artifact." }] }, selectedItemIndexes: [0],
      });
      expect(capsules(input, "runtime_child_result").map((value) => value.outcome)).toEqual(["yielded", "completed"]);
      expect(JSON.stringify(input.messages)).not.toContain("STALE_PLANNER_TARGET");
      return reply({ action: "return_result", result: "The newest artifact was created." });
    }
    if (input.modelStep === "worker.evidence") return workerEvidenceReply(input, executeWrite.mock.calls.length === 0);
    if (input.modelStep === "worker.decision") {
      workerDecisions += 1;
      expect(capsules(input, REQUEST_STEERING_MESSAGE_KIND)).toHaveLength(0);
      const assignment = capsules(input, "runtime_worker_assignment")[0]!;
      workerCallIds.push(assignment.callId);
      const encoded = JSON.stringify(assignment);
      expect(encoded).not.toContain("STALE_PLANNER_TARGET");
      if (workerDecisions === 1) {
        expect(encoded).toContain("fixture.read");
        expect(encoded).not.toContain("fixture.write");
        steering.append({ steerId: "replace", text: "Replace the read task with writing." });
        return reply({ action: "invoke_capability", capabilityId: "fixture.read", intent: "Read the old artifact." });
      }
      expect(encoded).toContain("fixture.write");
      expect(encoded).not.toContain("fixture.read");
      return reply({ action: "invoke_capability", capabilityId: "fixture.write", intent: "Create the newest artifact." });
    }
    if (input.modelStep === "worker.result") {
      workerResults += 1;
      expect(JSON.stringify(input.messages)).not.toContain("STALE_PLANNER_TARGET");
      return { text: "The newest artifact was created.", meta: {} };
    }
    if (input.modelStep === "supervisor.response") return { text: "The newest artifact was created.", meta: {} };
    throw new Error(`Unexpected model step ${input.modelStep}`);
  });
  const request = createTestRequestExecutionScope({
    requestId: "steering-reallocation", sessionId: "steering-reallocation-session",
    prompt: "Complete the original artifact task.", historyMessages: [], shouldGenerateSessionTitle: false,
    runnerConfig, modelPolicy, agentMode: "reasoning", toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal, requestSteering: steering,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined), onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
    workerCapabilityProvider: { getDescriptors: () => adapters.map(({ descriptor }) => descriptor), getAdapters: () => adapters },
    modelGatewayClient: { invoke: separateSupervisorRunnerModelPhases(invoke, { planner: ".", worker: "." }), invokeRaw: vi.fn() },
  });
  await expect(runRequestRunner(request)).resolves.toEqual({ output: "The newest artifact was created." });
  expect(plannerDecisions).toBe(4);
  expect(workerDecisions).toBe(2);
  expect(workerResults).toBe(1);
  expect(workerCallIds).toEqual(["call-3", "call-4"]);
  expect(executeRead).not.toHaveBeenCalled();
  expect(executeWrite).toHaveBeenCalledTimes(1);
  expect(executeWrite.mock.calls[0]![0].call).toMatchObject({
    callId: "call-4", parentCallId: "call-2", workerSteeringVersion: 2,
    workerCapabilityScope: { catalogGroupIds: ["write"] }, objective: "Create only the newest artifact.",
  });
});
