import { vi } from "vitest";
import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { RequestExecutionPolicyId } from "../../config/model-execution-policy.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
} from "../../orchestration/role-calls/index.js";
import type { ModelGatewayClient } from "../../ports.js";
import type { CompiledRequestExecutionPolicy } from "../../request/execution-scope.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import {
  createTestRequestExecutionScope,
  type TestRequestSeed,
} from "./request-execution-scope.js";
import { directRespondText } from "./supervisor-direct-respond.js";

const invokedSteps = Object.values(MODEL_STEPS);

export const INVALID_OUTPUT_RUNNER_CONFIG: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "invalid-output-test",
      steps: Object.fromEntries(invokedSteps.map((step) => [step, step])),
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: Object.fromEntries(
    invokedSteps.map((step) => [step, { timeoutMs: 20_000 }]),
  ),
};

export const INVALID_OUTPUT_MODEL_POLICY = {
  providers: { test: { type: "ollama" as const } },
  profiles: {
    "invalid-output-test": {
      provider: "test",
      model: "invalid-output-test",
      contextWindowTokens: 128_000,
    },
  },
  defaults: INVALID_OUTPUT_RUNNER_CONFIG.models.defaults,
};

export const ROOT_OUTPUT_POLICIES = [
  {
    policyId: "supervisor-worker-v1",
    decisionStep: "supervisor.decision",
    responseStep: "supervisor.response",
    invalidDecision: "invalid_supervisor_decision",
    invalidResponse: "invalid_supervisor_response",
    invalidAuthoredResponse: "invalid_supervisor_response",
    responseAttempts: 2,
  },
  {
    policyId: "execution-agent-v1",
    decisionStep: "execution.decision",
    responseStep: "execution.response",
    invalidDecision: "invalid_execution_agent_decision",
    invalidResponse: "invalid_execution_agent_response",
    invalidAuthoredResponse: "invalid_execution_agent_authored_response",
    responseAttempts: 3,
  },
] as const;

export function rootRespondOutput(policyId: RequestExecutionPolicyId): string {
  if (policyId === "supervisor-worker-v1")
    return directRespondText("I will report the established result.");
  return JSON.stringify({
    decision: {
      action: "respond",
      acknowledgement: "I will report the established result.",
    },
  });
}

export function createRootInvalidOutputRequest(
  invoke: ModelGatewayClient["invoke"],
  policyId: RequestExecutionPolicyId = "supervisor-worker-v1",
  overrides: Partial<TestRequestSeed> = {},
  executionPolicy: CompiledRequestExecutionPolicy = resolveRequestExecutionPolicy(
    policyId,
  ),
) {
  return createTestRequestExecutionScope(
    {
      requestId: "root-invalid-request",
      sessionId: "root-invalid-session",
      prompt: "Complete the requested work and report the established result.",
      historyMessages: [],
      shouldGenerateSessionTitle: false,
      runnerConfig: INVALID_OUTPUT_RUNNER_CONFIG,
      modelPolicy: INVALID_OUTPUT_MODEL_POLICY,
      agentMode: "reasoning",
      executionPolicySelection: {
        policy: policyId,
        source: "model_profile",
        primaryProfileId: "invalid-output-test",
      },
      modelGatewayClient: { invoke, invokeRaw: vi.fn() },
      workerCapabilityProvider: {
        getDescriptors: () => [],
        getAdapters: () => [],
      },
      toolPermissionMode: "full_access",
      abortSignal: new AbortController().signal,
      onAcknowledgement: vi.fn(),
      onSessionTitle: vi.fn(async () => undefined),
      onThinkingDelta: vi.fn(),
      onThinkingTrace: vi.fn(),
      onAnswerToken: vi.fn(),
      onEvent: vi.fn(),
      ...overrides,
    },
    { executionPolicy },
  );
}

export async function createRootInvalidOutputLedger(
  policyId: RequestExecutionPolicyId = "supervisor-worker-v1",
  maxResponseChars = ROLE_CALL_RESPONSE_MAX_LENGTH,
) {
  const ledger = createRoleCallLedger({
    requestId: "root-invalid-request",
    policy: {
      authority: resolveRequestExecutionPolicy(policyId).authority,
      limits: {
        maxDepth: 12,
        maxCalls: 48,
        maxCapabilityExecutions: 96,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars,
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
