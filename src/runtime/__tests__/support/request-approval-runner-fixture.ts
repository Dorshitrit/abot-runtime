import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { expect, vi } from "vitest";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityPreparedExecution,
} from "../../orchestration/worker-capabilities/index.js";
import { createRoleExecutorRegistry } from "../../orchestration/role-executors/index.js";
import type {
  CompiledRequestExecutionPolicy,
  RequestCapabilityExecutionView,
  RequestExecutionScope,
} from "../../request/execution-scope.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../../request/result.js";
import type { ToolApprovalRequest } from "../../ports.js";

export const actionFingerprint = `sha256:${"a".repeat(64)}`;
const approvalRequest: ToolApprovalRequest = {
  requestId: "runner-approval",
  approvalId: "approval-exact",
  call: { tool: "fixture.observe", params: { target: "original" } },
};

export function createApprovalRunnerFixture(
  options: { beforeRestore?: () => Promise<void> } = {},
) {
  const requestSteering = createRequestSteeringInbox({
    requestId: "runner-approval",
  });
  const abortController = new AbortController();
  const appliedDecisions = vi.fn();
  const executed = vi.fn();
  const performed = vi.fn();
  const prepare = vi.fn(async () => prepared());
  const restore = vi.fn(async (_input, snapshot) => {
    expect(snapshot).toEqual({ target: "original" });
    await options.beforeRestore?.();
    return prepared();
  });
  function prepared(): WorkerCapabilityPreparedExecution {
    let approved: boolean | undefined;
    return {
      actionFingerprint,
      acceptedControls: {},
      snapshot: { target: "original" },
      approvalRequest,
      applyApprovalDecision: (decision) => {
        appliedDecisions(decision);
        approved = decision.decision.approved;
      },
      async execute(executionId) {
        executed(executionId);
        if (approved === undefined)
          throw new Error("dispatch_without_decision");
        if (approved) performed(executionId, "original");
        const result = {
          observedEffect: approved ? "observation" : "none",
          summary: approved ? "Observed." : "Declined.",
          exactResult: {
            kind: "generic_capability_result_v1",
            authority: "capability_adapter",
            status: "executed",
            ok: approved,
            payload: { approved, target: "original" },
          },
        } as const;
        if (approved)
          return {
            ...result,
            outcome: "succeeded",
            observedEffect: "observation",
          };
        return {
          ...result,
          outcome: "failed",
          failureOutcomeFingerprint: null,
        };
      },
    };
  }
  const adapter: WorkerCapabilityAdapter<RequestCapabilityExecutionView> = {
    descriptor: {
      capabilityId: "fixture.observe",
      summary: "Observe one exact target.",
      effect: "observation",
      controls: {
        type: "object",
        properties: {},
        additionalProperties: false,
        required: [],
      },
    },
    prepare,
    restore,
    execute: async () => {
      throw new Error("unexpected unprepared dispatch");
    },
  };
  const decide = vi.fn<
    CompiledRequestExecutionPolicy["rootContract"]["decide"]
  >(async (request, options) => {
    const execution = options.head.state.capabilityExecutions[0];
    if (!execution)
      return {
        steeringVersion: request.requestSteering?.snapshot().version ?? 0,
        decision: {
          action: "invoke_capability",
          capabilityId: "fixture.observe",
          intent: "Observe.",
          controls: {},
          acknowledgement: "Checking.",
        },
      };
    expect(execution.status).toBe("settled");
    return {
      steeringVersion: request.requestSteering?.snapshot().version ?? 0,
      decision: {
        action: "blocked",
        response: `Finished: ${execution.outcome}.`,
      },
    };
  });
  const policy: CompiledRequestExecutionPolicy = {
    authority: {
      id: "approval-test",
      version: 1,
      definitionHash: `sha256:${"b".repeat(64)}`,
      rootContractId: "approval_test",
      availableSubordinateContractIds: [],
      capabilityAuthorities: ["root"],
      terminalTextMode: "exact",
    },
    roleExecutors: createRoleExecutorRegistry<
      RequestExecutionScope,
      RequestRoleExecutionHandoff
    >([]),
    rootContract: {
      contractId: "approval_test",
      decisionModelStep: "execution.decision",
      responseModelStep: "execution.response",
      projectCallIdentity: (head) => {
        const call = head.state.calls[0]!;
        return {
          rootCallId: call.callId,
          callId: call.callId,
          parentCallId: call.parentCallId,
          depth: call.depth,
          invocationAttempt: call.activationCount,
        };
      },
      projectResume: () => {
        throw new Error("unexpected child");
      },
      decide,
      authorResponse: async () => {
        throw new Error("unexpected model response");
      },
    },
  };
  const onAnswerToken = vi.fn();
  const onAcknowledgement = vi.fn();
  const makeRequest = () =>
    createTestRequestExecutionScope(
      {
        requestId: "runner-approval",
        sessionId: "session-approval",
        prompt: "Original request",
        historyMessages: [],
        shouldGenerateSessionTitle: false,
        runnerConfig: {
          models: { defaults: { profileId: "unused", steps: {} } },
          context: {
            outputReserveTokens: 128,
            safetyReserveTokens: 64,
            attachmentReserveTokens: 32,
          },
          steps: {},
        },
        agentMode: "reasoning",
        toolPermissionMode: "ask",
        abortSignal: abortController.signal,
        requestSteering,
        modelGatewayClient: {
          invoke: async () => {
            throw new Error("unexpected model");
          },
          invokeRaw: async () => {
            throw new Error("unexpected raw model");
          },
        },
        workerCapabilityProvider: {
          getDescriptors: () => [adapter.descriptor],
          getAdapters: () => [adapter],
        },
        approvalGate: { resolve: async () => ({ kind: "awaiting_approval" }) },
        onAcknowledgement,
        onSessionTitle: vi.fn(async () => undefined),
        onAnswerToken,
        onThinkingDelta: vi.fn(),
        onThinkingTrace: vi.fn(),
        onEvent: vi.fn(),
      },
      { executionPolicy: policy },
    );
  return {
    makeRequest,
    requestSteering,
    abortController,
    appliedDecisions,
    executed,
    prepare,
    restore,
    performed,
    decide,
    onAnswerToken,
    onAcknowledgement,
  };
}
