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
} from "../orchestration/role-calls/index.js";
import { createRoleExecutorRegistry } from "../orchestration/role-executors/index.js";
import type { ModelGatewayClient } from "../ports.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import {
  type CompiledRequestExecutionPolicy,
  type RequestExecutionScope,
} from "../request/execution-scope.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { runRootExecutionKernel } from "../request/root-execution-kernel.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import type { RequestRoleExecutionHandoff } from "../request/result.js";

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

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("root execution kernel policy mechanics", () => {
  test("drops stale nonterminal presentation for a fresh-presentation contract", async () => {
    const requestSteering = createRequestSteeringInbox({
      requestId: "fresh-presentation-request",
    });
    const ledger = createExactRootLedger("fresh-presentation-request");
    await createRoot(ledger);
    const onSessionTitle = vi.fn(async () => undefined);
    const onAcknowledgement = vi.fn();
    let decisionCount = 0;
    const policy: CompiledRequestExecutionPolicy = Object.freeze({
      authority: ledger.current().policy.authority,
      roleExecutors: createRoleExecutorRegistry<
        RequestExecutionScope,
        RequestRoleExecutionHandoff
      >([]),
      rootContract: Object.freeze({
        contractId: "fresh_presentation_test",
        decisionModelStep: "execution.decision",
        responseModelStep: "execution.response",
        deferRespondPresentation: true,
        projectCallIdentity(head) {
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
        async decide() {
          decisionCount += 1;
          const steeringVersion = requestSteering.snapshot().version;
          if (decisionCount === 1) {
            expect(
              requestSteering.append({
                steerId: "new-user-direction",
                text: "Use the new direction.",
              }),
            ).toMatchObject({ ok: true, duplicate: false });
            return Object.freeze({
              steeringVersion,
              decision: Object.freeze({
                action: "update_capability_scope" as const,
                mode: "open" as const,
                catalogGroupIds: Object.freeze(["stale"]),
                title: "Stale title",
                acknowledgement: "Stale acknowledgement",
              }),
            });
          }
          return Object.freeze({
            steeringVersion,
            decision: Object.freeze({
              action: "blocked" as const,
              response: "  Fresh exact response.\n\t",
            }),
          });
        },
        async authorResponse() {
          throw new Error("unexpected response authoring");
        },
      }),
    });

    const result = await runRootExecutionKernel({
      request: createRequest(
        {
          requestSteering,
          onSessionTitle,
          onAcknowledgement,
        },
        policy,
      ),
      ledger,
    });

    expect(result).toEqual({
      output: "  Fresh exact response.\n\t",
      outputTextMode: "exact",
    });
    expect(decisionCount).toBe(2);
    expect(onSessionTitle).not.toHaveBeenCalled();
    expect(onAcknowledgement).not.toHaveBeenCalled();
    expect(ledger.current().state.calls[0]).not.toHaveProperty(
      "workerCapabilityScope",
    );
  });
});

function createExactRootLedger(requestId: string): RoleCallLedger {
  return createRoleCallLedger({
    requestId,
    policy: {
      authority: {
        id: "fresh-presentation-test",
        version: 1,
        definitionHash: `sha256:${"b".repeat(64)}`,
        rootContractId: "fresh_presentation_test",
        availableSubordinateContractIds: [],
        capabilityAuthorities: ["root"],
        terminalTextMode: "exact",
      },
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

async function createRoot(ledger: RoleCallLedger): Promise<void> {
  const created = await ledger.apply({
    expectedHead: ledger.current(),
    command: { authority: "runtime", type: "create_root" },
  });
  if (!created.ok) throw new Error(created.code);
}

function createRequest(
  overrides: {
    requestSteering: ReturnType<typeof createRequestSteeringInbox>;
    onSessionTitle: RequestExecutionSeed["onSessionTitle"];
    onAcknowledgement: RequestExecutionSeed["onAcknowledgement"];
  },
  executionPolicy: CompiledRequestExecutionPolicy,
): RequestExecutionScope {
  const unexpectedGateway = async () => {
    throw new Error("unexpected model invocation");
  };
  return createTestRequestExecutionScope({
    requestId: "fresh-presentation-request",
    sessionId: "fresh-presentation-session",
    prompt: "Original request",
    historyMessages: [],
    shouldGenerateSessionTitle: true,
    runnerConfig,
    agentMode: "reasoning",
    modelGatewayClient: {
      invoke: unexpectedGateway as ModelGatewayClient["invoke"],
      invokeRaw: unexpectedGateway as ModelGatewayClient["invokeRaw"],
    },
    requestSteering: overrides.requestSteering,
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: overrides.onAcknowledgement,
    onSessionTitle: overrides.onSessionTitle,
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  }, { executionPolicy });
}
