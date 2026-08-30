import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import { createRoleExecutorRegistry } from "../orchestration/role-executors/index.js";
import type {
  WorkerCapabilityAdapter,
  WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import type {
  CompiledRequestExecutionPolicy,
  RequestExecutionScope,
} from "../request/execution-scope.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import type { RequestRoleExecutionHandoff } from "../request/result.js";
import { buildDegradedFinalizationFallback } from "../steps/degraded-finalization/fallback.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const runnerConfig: RequestRunnerConfig = Object.freeze({
  models: Object.freeze({
    defaults: Object.freeze({ profileId: "unused", steps: Object.freeze({}) }),
  }),
  context: Object.freeze({
    outputReserveTokens: 128,
    safetyReserveTokens: 64,
    attachmentReserveTokens: 32,
  }),
  steps: Object.freeze({}),
});

const descriptor: WorkerCapabilityDescriptor = Object.freeze({
  capabilityId: "files.read_exact",
  summary: "Read one exact file.",
  effect: "observation",
  controls: Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze({
      path: Object.freeze({
        type: "string" as const,
        minLength: 1,
        maxLength: 4_096,
      }),
    }),
    required: Object.freeze(["path"]),
  }),
  catalogGroups: Object.freeze(["files"]),
});

const exactInvocation = Object.freeze({
  capabilityId: descriptor.capabilityId,
  intent: "Read the exact selected file.",
  controls: Object.freeze({ path: "project/exact.txt" }),
});

const degradedInput = Object.freeze({
  problem: Object.freeze({
    stage: "operation_supervision",
    code: "operation_supervision_limit_exceeded",
  }),
  progress: null,
});

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("root operation-supervision terminal behavior", () => {
  test("commits a truthful degraded response after the intervention limit", async () => {
    const requestId = "root-operation-supervision-limit";
    const ledger = await createRootLedger(requestId);
    const physicalExecution = vi.fn(async () =>
      Object.freeze({
        outcome: "succeeded" as const,
        observedEffect: "observation" as const,
        summary: "Read exact.txt.",
      }),
    );
    const adapter: WorkerCapabilityAdapter<unknown> = Object.freeze({
      descriptor,
      prepare: vi.fn(async ({ controls }) =>
        Object.freeze({
          actionFingerprint: `sha256:${"a".repeat(64)}`,
          acceptedControls: controls,
          execute: physicalExecution,
        }),
      ),
      execute: async () => {
        throw new Error("prepared adapter execution was bypassed");
      },
    });
    const requestSteering = createRequestSteeringInbox({ requestId });
    let decisionCount = 0;
    const policy = createPolicy(ledger, async () => {
      decisionCount += 1;
      return Object.freeze({
        steeringVersion: requestSteering.snapshot().version,
        decision: Object.freeze({
          action: "invoke_capability" as const,
          ...exactInvocation,
        }),
      });
    });

    const result = await runRootExecutionKernel({
      request: createRequest({
        requestId,
        requestSteering,
        adapter,
        policy,
      }),
      ledger,
    });

    const expectedOutput = buildDegradedFinalizationFallback(degradedInput);
    expect(result).toEqual({
      output: expectedOutput,
      outputTextMode: "exact",
    });
    expect(decisionCount).toBe(4);
    expect(physicalExecution).toHaveBeenCalledTimes(2);
    expect(ledger.current().state).toMatchObject({
      phase: "completed",
      activeCallId: null,
      rootResponse: expectedOutput,
      capabilityExecutions: [
        { status: "settled", outcome: "succeeded" },
        { status: "settled", outcome: "succeeded" },
      ],
      operationSupervision: {
        entries: [
          {
            stage: "intervened",
            matchingOutcomeCount: 2,
            priorOutcome: "succeeded",
          },
        ],
      },
    });
    expect(ledger.current().state.calls[0]).toMatchObject({
      status: "completed",
    });
  });

  test("preserves unrelated capability errors as failures", async () => {
    const requestId = "root-unrelated-capability-error";
    const ledger = await createRootLedger(requestId);
    const adapter: WorkerCapabilityAdapter<unknown> = Object.freeze({
      descriptor,
      execute: async () => {
        throw new Error("prepared adapter execution was bypassed");
      },
    });
    const requestSteering = createRequestSteeringInbox({ requestId });
    const policy = createPolicy(ledger, async () =>
      Object.freeze({
        steeringVersion: requestSteering.snapshot().version,
        decision: Object.freeze({
          action: "invoke_capability" as const,
          ...exactInvocation,
          capabilityId: "files.unavailable",
        }),
      }),
    );

    await expect(
      runRootExecutionKernel({
        request: createRequest({
          requestId,
          requestSteering,
          adapter,
          policy,
        }),
        ledger,
      }),
    ).rejects.toThrow("worker_capability_rejected:capability_unavailable");
    expect(ledger.current().state).toMatchObject({
      phase: "running",
      rootResponse: null,
      capabilityExecutions: [],
    });
  });
});

async function createRootLedger(requestId: string): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: {
        id: "root-operation-supervision-test",
        version: 1,
        definitionHash: `sha256:${"b".repeat(64)}`,
        rootContractId: "root_operation_supervision_test",
        availableSubordinateContractIds: [],
        capabilityAuthorities: ["root"],
        terminalTextMode: "exact",
      },
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  const created = await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  if (!created.ok) throw new Error(created.code);
  return ledger;
}

function createPolicy(
  ledger: RoleCallLedger,
  decide: CompiledRequestExecutionPolicy["rootContract"]["decide"],
): CompiledRequestExecutionPolicy {
  return Object.freeze({
    authority: ledger.current().policy.authority,
    roleExecutors: createRoleExecutorRegistry<
      RequestExecutionScope,
      RequestRoleExecutionHandoff
    >([]),
    rootContract: Object.freeze({
      contractId: "root_operation_supervision_test",
      decisionModelStep: "execution.decision",
      responseModelStep: "execution.response",
      projectCallIdentity(head: RoleCallLedgerHead) {
        const root = head.state.calls[0]!;
        return Object.freeze({
          rootCallId: root.callId,
          callId: root.callId,
          parentCallId: root.parentCallId,
          depth: root.depth,
          invocationAttempt: root.activationCount,
        });
      },
      projectResume() {
        throw new Error("unexpected child resume");
      },
      decide,
      async authorResponse() {
        throw new Error("unexpected response authoring");
      },
    }),
  });
}

function createRequest(params: {
  requestId: string;
  requestSteering: ReturnType<typeof createRequestSteeringInbox>;
  adapter: WorkerCapabilityAdapter<unknown>;
  policy: CompiledRequestExecutionPolicy;
}): RequestExecutionScope {
  const unexpectedGateway = async () => {
    throw new Error("unexpected model invocation");
  };
  return createTestRequestExecutionScope(
    {
      requestId: params.requestId,
      sessionId: `${params.requestId}-session`,
      prompt: "Read the exact file without repeating a faulty operation.",
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig,
      agentMode: "reasoning",
      modelGatewayClient: {
        invoke: unexpectedGateway as ModelGatewayClient["invoke"],
        invokeRaw: unexpectedGateway as ModelGatewayClient["invokeRaw"],
      },
      requestSteering: params.requestSteering,
      workerCapabilityProvider: {
        getDescriptors: () => Object.freeze([descriptor]),
        getAdapters: () => Object.freeze([params.adapter]),
      },
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn<RequestExecutionSeed["onSessionTitle"]>(),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
    },
    { executionPolicy: params.policy },
  );
}
