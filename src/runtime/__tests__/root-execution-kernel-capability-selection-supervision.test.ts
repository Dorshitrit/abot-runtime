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
import { MODEL_STEPS } from "../../shared/model-steps.js";
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

const repeatedSelection = Object.freeze({
  action: "invoke_capability" as const,
  invocations: Object.freeze([
    Object.freeze({
      capabilityId: descriptor.capabilityId,
      intent: "Read the exact selected file.",
      selectionControlsJson: '{"path":"project/exact.txt"}',
    }),
  ]),
  workingDirectory: null,
  activeCapabilityCatalogGroupIds: Object.freeze(["files"]),
});

const repeatedCause = Object.freeze({
  kind: "refinement_declined" as const,
  entries: Object.freeze([
    Object.freeze({
      invocationIndex: 0,
      reason: "The capability guidance does not match the request.",
    }),
  ]),
});

const degradedInput = Object.freeze({
  problem: Object.freeze({
    stage: "capability_selection_supervision",
    code: "capability_selection_supervision_limit_exceeded",
  }),
  progress: null,
});

const activationPreemptionDegradedInput = Object.freeze({
  problem: Object.freeze({
    stage: "capability_selection_supervision",
    code: "role_activation_limit_exceeded",
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

describe("root capability-selection supervision terminal behavior", () => {
  test("commits a canonical degraded response across absent and equivalent working-directory representations", async () => {
    const requestId = "root-capability-selection-supervision-limit";
    const ledger = await createScopedRootLedger(requestId);
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
      execute: vi.fn(async () => {
        throw new Error("capability adapter execution was not expected");
      }),
    });
    const requestSteering = createRequestSteeringInbox({ requestId });
    let decisionCount = 0;
    const policy = createPolicy(ledger, async () => {
      decisionCount += 1;
      return Object.freeze({
        steeringVersion: requestSteering.snapshot().version,
        decision: Object.freeze({
          action: "reconsider_capability_selection" as const,
          selection: repeatedSelectionVariant(decisionCount),
          cause: repeatedCause,
        }),
      });
    });

    expect(ledger.current().state.calls[0]?.workingDirectory).toBeUndefined();

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
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(physicalExecution).not.toHaveBeenCalled();
    expect(ledger.current().state).toMatchObject({
      phase: "completed",
      activeCallId: null,
      rootResponse: expectedOutput,
      capabilityExecutions: [],
    });
    expect(ledger.current().state.calls[0]).toMatchObject({
      status: "completed",
      activationCount: 5,
    });
  });

  test("commits degraded completion when eight distinct selections exhaust the total budget", async () => {
    const requestId = "root-capability-selection-supervision-total-limit";
    const ledger = await createScopedRootLedger(requestId);
    const adapter = createNoExecutionAdapter();
    const requestSteering = createRequestSteeringInbox({ requestId });
    let decisionCount = 0;
    const policy = createPolicy(ledger, async () => {
      decisionCount += 1;
      return Object.freeze({
        steeringVersion: requestSteering.snapshot().version,
        decision: Object.freeze({
          action: "reconsider_capability_selection" as const,
          selection: selectionForPath(`project/distinct-${decisionCount}.txt`),
          cause: repeatedCause,
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

    expect(result).toEqual({
      output: buildDegradedFinalizationFallback(degradedInput),
      outputTextMode: "exact",
    });
    expect(decisionCount).toBe(8);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(ledger.current().state).toMatchObject({
      phase: "completed",
      capabilityExecutions: [],
    });
  });

  test("degrades safely when a smaller general activation budget preempts the local threshold", async () => {
    const requestId = "root-capability-selection-activation-preemption";
    const ledger = await createScopedRootLedger(requestId, {
      maxCalls: 1,
      maxCapabilityExecutions: 1,
    });
    const adapter = createNoExecutionAdapter();
    const requestSteering = createRequestSteeringInbox({ requestId });
    let decisionCount = 0;
    const policy = createPolicy(ledger, async () => {
      decisionCount += 1;
      return Object.freeze({
        steeringVersion: requestSteering.snapshot().version,
        decision: Object.freeze({
          action: "reconsider_capability_selection" as const,
          selection: repeatedSelectionVariant(decisionCount),
          cause: repeatedCause,
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

    expect(result).toEqual({
      output: buildDegradedFinalizationFallback(
        activationPreemptionDegradedInput,
      ),
      outputTextMode: "exact",
    });
    expect(decisionCount).toBe(2);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(ledger.current().state).toMatchObject({
      phase: "completed",
      capabilityExecutions: [],
      capabilitySelectionSupervision: { epoch: null, records: [] },
    });
  });

  test("preserves an unrelated reconsideration rejection as an error", async () => {
    const requestId = "root-capability-selection-unrelated-rejection";
    const ledger = await createScopedRootLedger(requestId);
    const adapter = createNoExecutionAdapter();
    const requestSteering = createRequestSteeringInbox({ requestId });
    const policy = createPolicy(ledger, async () =>
      Object.freeze({
        steeringVersion: requestSteering.snapshot().version,
        decision: Object.freeze({
          action: "reconsider_capability_selection" as const,
          selection: Object.freeze({
            ...repeatedSelection,
            activeCapabilityCatalogGroupIds: Object.freeze(["unbound"]),
          }),
          cause: repeatedCause,
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
    ).rejects.toThrow(
      "role_call_ledger_rejected:capability_selection_reconsideration_invalid",
    );
    expect(ledger.current().state).toMatchObject({
      phase: "running",
      rootResponse: null,
      capabilityExecutions: [],
      capabilitySelectionSupervision: { epoch: null, records: [] },
    });
  });

  test("drops stale degraded finalization when steering changes and completes from the fresh activation", async () => {
    const requestId = "root-capability-selection-steered-finalization";
    const ledger = await createScopedRootLedger(requestId);
    const adapter = createNoExecutionAdapter();
    const requestSteering = createRequestSteeringInbox({ requestId });
    let decisionCount = 0;
    const policy = createPolicy(ledger, async () => {
      decisionCount += 1;
      const steeringVersion = requestSteering.snapshot().version;
      return Object.freeze({
        steeringVersion,
        decision:
          decisionCount <= 4
            ? Object.freeze({
                action: "reconsider_capability_selection" as const,
                selection: repeatedSelection,
                cause: repeatedCause,
              })
            : Object.freeze({
                action: "blocked" as const,
                response: "Fresh steered response.",
              }),
      });
    });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
      expect(
        requestSteering.append({
          steerId: "replace-stale-finalization",
          text: "Use the fresh response instead.",
        }),
      ).toMatchObject({ ok: true, duplicate: false });
      return {
        text: JSON.stringify({
          failureNotice: "Stale degraded response.",
          nextStep: "Stale next step.",
        }),
        meta: {},
      };
    });

    const result = await runRootExecutionKernel({
      request: createRequest({
        requestId,
        requestSteering,
        adapter,
        policy,
        runnerConfig: degradedRunnerConfig,
        modelGatewayClient: {
          invoke,
          invokeRaw: async () => {
            throw new Error("unexpected raw model invocation");
          },
        },
      }),
      ledger,
    });

    expect(result).toEqual({
      output: "Fresh steered response.",
      outputTextMode: "exact",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(decisionCount).toBe(5);
    expect(ledger.current().state).toMatchObject({
      phase: "completed",
      rootResponse: "Fresh steered response.",
      capabilityExecutions: [],
      capabilitySelectionSupervision: { epoch: null, records: [] },
    });
  });
});

const degradedRunnerConfig: RequestRunnerConfig = Object.freeze({
  models: Object.freeze({
    defaults: Object.freeze({
      profileId: "runtime-test",
      steps: Object.freeze({
        [MODEL_STEPS.DEGRADED_FINALIZATION]: MODEL_STEPS.DEGRADED_FINALIZATION,
      }),
    }),
  }),
  context: runnerConfig.context,
  steps: Object.freeze({
    [MODEL_STEPS.DEGRADED_FINALIZATION]: Object.freeze({ timeoutMs: 20_000 }),
  }),
});

function selectionForPath(path: string) {
  return Object.freeze({
    ...repeatedSelection,
    invocations: Object.freeze([
      Object.freeze({
        ...repeatedSelection.invocations[0],
        selectionControlsJson: JSON.stringify({ path }),
      }),
    ]),
  });
}

function repeatedSelectionVariant(decisionCount: number) {
  if (decisionCount < 1 || decisionCount > 4) {
    throw new Error(`unexpected repeated selection variant ${decisionCount}`);
  }
  return Object.freeze({
    action: repeatedSelection.action,
    invocations: Object.freeze([
      Object.freeze({
        ...repeatedSelection.invocations[0],
        intent: `Read the same exact file, wording variant ${decisionCount}.`,
      }),
    ]),
    workingDirectory: decisionCount % 2 === 0 ? "." : null,
    activeCapabilityCatalogGroupIds:
      repeatedSelection.activeCapabilityCatalogGroupIds,
  });
}

function createNoExecutionAdapter(): WorkerCapabilityAdapter<unknown> {
  return Object.freeze({
    descriptor,
    execute: vi.fn(async () => {
      throw new Error("capability adapter execution was not expected");
    }),
  });
}

async function createScopedRootLedger(
  requestId: string,
  limits: Readonly<{
    maxCalls: number;
    maxCapabilityExecutions: number;
  }> = { maxCalls: 8, maxCapabilityExecutions: 16 },
): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: {
        id: "root-capability-selection-supervision-test",
        version: 1,
        definitionHash: `sha256:${"b".repeat(64)}`,
        rootContractId: "root_capability_selection_supervision_test",
        availableSubordinateContractIds: [],
        capabilityAuthorities: ["root"],
        terminalTextMode: "exact",
      },
      limits: {
        maxDepth: 4,
        maxCalls: limits.maxCalls,
        maxCapabilityExecutions: limits.maxCapabilityExecutions,
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
  const scoped = await ledger.apply({
    expectedHead: created.head,
    command: {
      authority: "active_role",
      type: "update_capability_scope",
      callId: created.head.state.rootCallId!,
      invocationAttempt: 1,
      mode: "open",
      catalogGroupIds: ["files"],
    },
  });
  if (!scoped.ok) throw new Error(scoped.code);
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
      contractId: "root_capability_selection_supervision_test",
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
  runnerConfig?: RequestRunnerConfig;
  modelGatewayClient?: ModelGatewayClient;
}): RequestExecutionScope {
  const unexpectedGateway = async () => {
    throw new Error("unexpected model invocation");
  };
  return createTestRequestExecutionScope(
    {
      requestId: params.requestId,
      sessionId: `${params.requestId}-session`,
      prompt: "Read the exact file without repeating a rejected selection.",
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig: params.runnerConfig ?? runnerConfig,
      agentMode: "reasoning",
      modelPolicy: {
        providers: { test: { type: "ollama" } },
        profiles: {
          "runtime-test": {
            provider: "test",
            model: "runtime-test-model",
            contextWindowTokens: 12_000,
          },
        },
        defaults: {
          profileId: "runtime-test",
          steps: {
            [MODEL_STEPS.DEGRADED_FINALIZATION]:
              MODEL_STEPS.DEGRADED_FINALIZATION,
          },
        },
      },
      modelGatewayClient:
        params.modelGatewayClient ??
        ({
          invoke: unexpectedGateway as ModelGatewayClient["invoke"],
          invokeRaw: unexpectedGateway as ModelGatewayClient["invokeRaw"],
        } satisfies ModelGatewayClient),
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
