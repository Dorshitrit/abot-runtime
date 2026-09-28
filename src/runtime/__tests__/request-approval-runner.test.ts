import { describe, expect, test, vi } from "vitest";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityPreparedExecution,
} from "../orchestration/worker-capabilities/index.js";
import { createRoleExecutorRegistry } from "../orchestration/role-executors/index.js";
import type {
  CompiledRequestExecutionPolicy,
  RequestCapabilityExecutionView,
  RequestExecutionScope,
} from "../request/execution-scope.js";
import { runRequestRunner } from "../request/runner.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../request/result.js";
import type { ToolApprovalRequest } from "../ports.js";

const actionFingerprint = `sha256:${"a".repeat(64)}`;
const approvalRequest: ToolApprovalRequest = {
  requestId: "runner-approval",
  approvalId: "approval-exact",
  call: { tool: "fixture.observe", params: { target: "original" } },
};

function fixture() {
  const performed = vi.fn();
  const prepare = vi.fn(async () => prepared());
  const restore = vi.fn(async (_input, snapshot) => {
    expect(snapshot).toEqual({ target: "original" });
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
        approved = decision.decision.approved;
      },
      async execute(executionId) {
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
  >(async (_request, options) => {
    const execution = options.head.state.capabilityExecutions[0];
    if (!execution)
      return {
        steeringVersion: 0,
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
      steeringVersion: 0,
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
        abortSignal: new AbortController().signal,
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
    prepare,
    restore,
    performed,
    decide,
    onAnswerToken,
    onAcknowledgement,
  };
}

describe("request runner approval boundary", () => {
  test.each([true, false])(
    "returns a data-only wait and resumes the same admitted action after decision=%s",
    async (approved) => {
      const f = fixture();
      const waiting = await runRequestRunner(f.makeRequest(), {
        durableApproval: true,
      });
      if (waiting.kind !== "awaiting_approval")
        throw new Error("expected wait");
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.performed).not.toHaveBeenCalled();
      expect(f.onAnswerToken).not.toHaveBeenCalled();
      expect(f.decide).toHaveBeenCalledOnce();
      const persisted = JSON.parse(JSON.stringify(waiting.continuation));
      const resumed = await runRequestRunner(f.makeRequest(), {
        durableApproval: true,
        continuation: persisted,
        decisions: [
          {
            approvalId: "approval-exact",
            actionFingerprint,
            decision: { approved },
          },
        ],
      });
      expect(resumed).toEqual({
        kind: "completed",
        result: {
          output: `Finished: ${approved ? "succeeded" : "failed"}.`,
          outputTextMode: "exact",
        },
      });
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.restore).toHaveBeenCalledOnce();
      expect(f.performed).toHaveBeenCalledTimes(approved ? 1 : 0);
      if (approved)
        expect(f.performed).toHaveBeenCalledWith(
          "capability-execution-1",
          "original",
        );
      expect(f.onAcknowledgement).toHaveBeenCalledOnce();
      expect(f.onAnswerToken).toHaveBeenCalledOnce();
      expect(f.decide).toHaveBeenCalledTimes(2);
    },
  );
});
