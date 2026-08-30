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

  test("drops memory candidates from a response superseded during authoring", async () => {
    const requestSteering = createRequestSteeringInbox({
      requestId: "stale-memory-response-request",
    });
    const ledger = createExactRootLedger("stale-memory-response-request");
    await createRoot(ledger);
    let authorCount = 0;
    const policy: CompiledRequestExecutionPolicy = Object.freeze({
      authority: ledger.current().policy.authority,
      roleExecutors: createRoleExecutorRegistry<
        RequestExecutionScope,
        RequestRoleExecutionHandoff
      >([]),
      rootContract: Object.freeze({
        contractId: "stale_memory_response_test",
        decisionModelStep: "execution.decision",
        responseModelStep: "execution.response",
        deferRespondPresentation: true,
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
        async decide() {
          return Object.freeze({
            steeringVersion: requestSteering.snapshot().version,
            decision: Object.freeze({ action: "respond" as const }),
          });
        },
        async authorResponse() {
          authorCount += 1;
          if (authorCount === 1) {
            requestSteering.append({
              steerId: "new-direction",
              text: "Use the fresh direction.",
            });
            return Object.freeze({
              finalResponse: "Stale response",
              memoryCandidates: Object.freeze([
                Object.freeze({ content: "Stale memory", tags: [] }),
              ]),
            });
          }
          return Object.freeze({
            finalResponse: "Fresh response",
            memoryCandidates: Object.freeze([
              Object.freeze({ content: "Fresh memory", tags: [] }),
            ]),
          });
        },
      }),
    });

    const result = await runRootExecutionKernel({
      request: createRequest(
        {
          requestSteering,
          onSessionTitle: vi.fn(async () => undefined),
          onAcknowledgement: vi.fn(),
        },
        policy,
      ),
      ledger,
    });

    expect(authorCount).toBe(2);
    expect(result).toMatchObject({
      output: "Fresh response",
      memoryCandidates: [{ content: "Fresh memory", tags: [] }],
    });
    expect(JSON.stringify(result)).not.toContain("Stale memory");
  });

  test("publishes a deferred title without a stale acknowledgement", async () => {
    const requestSteering = createRequestSteeringInbox({
      requestId: "deferred-title-request",
    });
    const ledger = createExactRootLedger("deferred-title-request");
    await createRoot(ledger);
    const onSessionTitle = vi.fn(async () => undefined);
    const onAcknowledgement = vi.fn();
    const policy: CompiledRequestExecutionPolicy = Object.freeze({
      authority: ledger.current().policy.authority,
      roleExecutors: createRoleExecutorRegistry<
        RequestExecutionScope,
        RequestRoleExecutionHandoff
      >([]),
      rootContract: Object.freeze({
        contractId: "deferred_title_test",
        decisionModelStep: "execution.decision",
        responseModelStep: "execution.response",
        deferRespondPresentation: true,
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
        async decide() {
          return Object.freeze({
            steeringVersion: requestSteering.snapshot().version,
            decision: Object.freeze({
              action: "respond" as const,
              title: "Useful title",
              acknowledgement: "Stale preliminary answer",
            }),
          });
        },
        async authorResponse() {
          return Object.freeze({
            finalResponse: "Fresh final answer",
            memoryCandidates: Object.freeze([]),
          });
        },
      }),
    });

    const result = await runRootExecutionKernel({
      request: createRequest(
        { requestSteering, onSessionTitle, onAcknowledgement },
        policy,
      ),
      ledger,
    });

    expect(result.output).toBe("Fresh final answer");
    expect(onSessionTitle).toHaveBeenCalledExactlyOnceWith("Useful title");
    expect(onAcknowledgement).not.toHaveBeenCalled();
  });

  test("never publishes an acknowledgement for a blocked terminal decision", async () => {
    const requestSteering = createRequestSteeringInbox({
      requestId: "terminal-acknowledgement-request",
    });
    const ledger = createExactRootLedger("terminal-acknowledgement-request");
    await createRoot(ledger);
    const onAcknowledgement = vi.fn();
    const policy: CompiledRequestExecutionPolicy = Object.freeze({
      authority: ledger.current().policy.authority,
      roleExecutors: createRoleExecutorRegistry<
        RequestExecutionScope,
        RequestRoleExecutionHandoff
      >([]),
      rootContract: Object.freeze({
        contractId: "terminal_acknowledgement_test",
        decisionModelStep: "supervisor.decision",
        responseModelStep: "supervisor.response",
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
        async decide() {
          return Object.freeze({
            steeringVersion: requestSteering.snapshot().version,
            decision: Object.freeze({
              action: "blocked" as const,
              response: "Publish only the blocked response.",
              acknowledgement: "Do not publish this preliminary response.",
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
          onSessionTitle: vi.fn(async () => undefined),
          onAcknowledgement,
        },
        policy,
      ),
      ledger,
    });

    expect(result.output).toBe("Publish only the blocked response.");
    expect(onAcknowledgement).not.toHaveBeenCalled();
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
    requestSteering: RequestExecutionSeed["requestSteering"];
    onSessionTitle: RequestExecutionSeed["onSessionTitle"];
    onAcknowledgement: RequestExecutionSeed["onAcknowledgement"];
  },
  executionPolicy: CompiledRequestExecutionPolicy,
): RequestExecutionScope {
  const unexpectedGateway = async () => {
    throw new Error("unexpected model invocation");
  };
  return createTestRequestExecutionScope(
    {
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
    },
    { executionPolicy },
  );
}
