import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../../model-gateway/message-contract.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import { createRoleCapabilityBinding } from "../../orchestration/worker-capabilities/index.js";
import type { ModelGatewayClient } from "../../ports.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../../request/role-executor-composition.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import {
  createTestRequestExecutionScope,
  type TestRequestSeed,
} from "./request-execution-scope.js";

const text = { type: "string", minLength: 1 } as const;
export const evidenceDescriptor: CapabilityDescriptor = {
  capabilityId: "evidence.read",
  summary: "Read exact source.",
  effect: "observation",
  catalogGroups: ["evidence"],
  selectionControlIds: ["path"],
  controls: {
    type: "object",
    additionalProperties: false,
    properties: { path: { ...text, maxLength: 4096 }, query: text },
    required: ["path", "query"],
  },
};
export const controlsReply = (
  controls: Record<string, unknown> = { query: "exact query" },
) => ({
  text: JSON.stringify({
    decision: {
      invocations: { invocation_1: { disposition: "execute", controls } },
    },
  }),
  meta: {},
});
export function activeEvidenceCall(head: RoleCallLedgerHead) {
  const call = head.state.calls.find(
    ({ callId }) => callId === head.state.activeCallId,
  );
  if (!call) throw new Error("fixture_active_call_missing");
  return call;
}
export function runtimeCapsule(
  messages: unknown,
  kind: string,
): Record<string, unknown> | undefined {
  validateModelGatewayMessages(messages);
  for (const { content } of messages as readonly ChatMessage[]) {
    try {
      const parsed = JSON.parse(content ?? "") as Record<string, unknown>;
      if (parsed.kind === kind) return parsed;
    } catch {
      /* text message */
    }
  }
  return undefined;
}
export async function createControlsEvidenceFixture(
  overrides: Partial<TestRequestSeed> = {},
  maxCapabilityExecutions = 192,
) {
  const requestId = "controls-evidence-test";
  const steering = createRequestSteeringInbox({ requestId });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () =>
    controlsReply(),
  );
  const counts: number[] = [];
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async () => ({
    inputTokens: counts.shift() ?? 1000,
    profileId: "test",
    provider: "openai",
    model: "test",
    contextWindowTokens: 32000,
    source: "provider_input_token_count",
  }));
  const steps = {
    "execution.decision": "execution.decision",
    "execution.response": "execution.response",
    "capability.controls": "capability.controls",
    "context.compact": "context.compact",
  } as const;
  const request = createTestRequestExecutionScope({
    requestId,
    sessionId: "controls-evidence-session",
    prompt: "Complete the exact bounded operation.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: { defaults: { profileId: "test", steps } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: Object.fromEntries(
        Object.keys(steps).map((key) => [key, { timeoutMs: 20000 }]),
      ),
    },
    modelPolicy: {
      providers: { openai: { type: "openai" } },
      profiles: {
        test: { provider: "openai", model: "test", contextWindowTokens: 32000 },
      },
      defaults: { profileId: "test", steps },
    },
    executionPolicySelection: {
      policy: "execution-agent-v1",
      primaryProfileId: "test",
      source: "model_profile",
    },
    agentMode: "reasoning",
    modelGatewayClient: { invoke, invokeRaw: vi.fn(), countInputTokens },
    workerCapabilityProvider: {
      getDescriptors: () => [evidenceDescriptor],
      getAdapters: () => [],
    },
    requestSteering: steering,
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
    ...overrides,
  });
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      limits: {
        maxDepth: 12,
        maxCalls: 48,
        maxCapabilityExecutions,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  async function commit(command: unknown) {
    const result = await ledger.apply({
      expectedHead: ledger.current(),
      command,
    });
    if (!result.ok) throw new Error(`fixture_commit_${result.code}`);
    return result.head;
  }
  await commit({ authority: "runtime", type: "create_root" });
  const call = activeEvidenceCall(ledger.current());
  await commit({
    authority: "active_role",
    type: "update_capability_scope",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    mode: "open",
    catalogGroupIds: ["evidence"],
  });
  async function addResult(
    body: string,
    options: { failed?: boolean; target?: string } = {},
  ) {
    const result = {
      summary: options.failed
        ? "Source read failed."
        : "Source read completed.",
      referenceData: body,
      references: [
        { kind: "tool_target" as const, target: options.target ?? "exact.txt" },
      ],
    };
    await createRoleCapabilityBinding({
      requestId,
      context: request,
      ledger,
      call: activeEvidenceCall(ledger.current()),
      adapters: [
        {
          descriptor: evidenceDescriptor,
          execute: vi.fn(async () =>
            options.failed
              ? {
                  ...result,
                  outcome: "failed" as const,
                  observedEffect: "none" as const,
                  failureOutcomeFingerprint: null,
                }
              : {
                  ...result,
                  outcome: "succeeded" as const,
                  observedEffect: "observation" as const,
                },
          ),
        },
      ],
    }).execute({
      capabilityId: evidenceDescriptor.capabilityId,
      intent: "Read source.",
      controls: {
        path: options.target ?? "exact.txt",
        query: `Read exact body ${ledger.current().state.capabilityExecutions.length}.`,
      },
    });
    return ledger.current().state.capabilityExecutions.at(-1)!.executionId;
  }
  return {
    request,
    ledger,
    steering,
    invoke,
    counts,
    countInputTokens,
    addResult,
    commit,
  };
}
