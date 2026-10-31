import { vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import {
  createRoleCallLedger,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
  type RoleCallFrame,
  type RoleCallPlanBinding,
} from "../../orchestration/role-calls/index.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { createWorkerDecisionModelPolicy, createWorkerDecisionRunnerConfig } from "./worker-decision-model-fixture.js";

export async function createSuperWorkerSteeringFixture(
  caller: "supervisor" | "planner" = "supervisor",
  invoke: ModelGatewayClient["invoke"] = vi.fn(async () => ({ text: "accepted", meta: {} })),
) {
  const requestId = "worker-steering-request";
  const steering = createRequestSteeringInbox({ requestId });
  const abort = new AbortController();
  const request = createTestRequestExecutionScope({
    requestId,
    sessionId: "worker-steering-session",
    prompt: "Perform the requested work.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: createWorkerDecisionRunnerConfig(),
    agentMode: "reasoning",
    modelPolicy: createWorkerDecisionModelPolicy(8_000),
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    requestSteering: steering,
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    abortSignal: abort.signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: request.executionPolicy.authority,
      limits: {
        maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
        maxObjectiveChars: 4_000, maxResultChars: 4_000, maxResponseChars: 4_000,
      },
    },
  });
  await applySteeringFixtureCommand(ledger, { authority: "runtime", type: "create_root" });
  if (caller === "planner") {
    await applySteeringFixtureCommand(ledger, {
      authority: "active_role", type: "open_child", callerCallId: "call-1",
      roleId: "planner", objective: "Coordinate the requested work.",
    });
  }
  const callerCall = ledger.current().state.calls.find(
    (call) => call.callId === ledger.current().state.activeCallId,
  )!;
  const workerInvocation: Readonly<{ objective: string; plannerPlan?: RoleCallPlanBinding }> = {
    objective: "Perform the bounded task.",
    ...(caller === "planner" ? {
      plannerPlan: {
        mode: "declare" as const,
        plan: { summary: "Complete the work.", items: [{ title: "Bounded work", objective: "Perform the bounded task." }] },
        selectedItemIndexes: [0],
      },
    } : {}),
  };
  return { request, ledger, callerCall, steering, abort, workerInvocation };
}

export async function applySteeringFixtureCommand(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
) {
  const applied = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!applied.ok) throw new Error(`fixture_transition_rejected:${applied.code}`);
  return applied;
}

export async function settleSteeringFixtureObservation(ledger: RoleCallLedger, call: RoleCallFrame) {
  const begun = await applySteeringFixtureCommand(ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: call.callId,
    invocationAttempt: call.activationCount, capabilityId: "fixture.observe",
    declaredEffect: "observation", intent: "Observe current work.", controlsJson: "{}",
  });
  if (begun.effect.type !== "capability_execution_begun") throw new Error("fixture_begin_invalid");
  const executionId = begun.effect.executionId;
  await applySteeringFixtureCommand(ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: call.callId,
    executionId, outcome: "succeeded", observedEffect: "observation", summary: "Observation retained.",
    exactResult: {
      kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed", ok: true,
      payload: { observed: "retained" },
    },
  });
  return executionId;
}
