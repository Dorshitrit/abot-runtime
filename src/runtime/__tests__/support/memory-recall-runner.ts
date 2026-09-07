import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  LongTermMemoryRecord,
  LongTermMemoryService,
} from "../../long-term-memory/contracts.js";
import type { ModelGatewayClient } from "../../ports.js";
import { createRequestSteeringInbox } from "../../request/request-steering.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

export type RecallPolicy = "supervisor-worker-v1" | "execution-agent-v1";
export type RecallModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export const RECALL_KIND = "runtime_memory_recall_reference_v1";
export const REQUEST_PROMPT = "Explain my saved formatting preference.";
export const RECALL_QUERY = "saved formatting preference";
export const FINAL_RESPONSE = "Use the saved preference when it applies.";
export const MEMORY_RECORD: LongTermMemoryRecord = Object.freeze({
  id: "memory-style",
  content: "Prefer two short paragraphs for routine explanations.",
  tags: ["format"],
  provenance: {
    kind: "passive_response" as const,
    sourceRequestId: "prior-request",
    sourceSessionId: "prior-session",
  },
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
});

export function modelMessages(input: RecallModelInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

export function jsonMessages(
  input: RecallModelInput,
): readonly Record<string, unknown>[] {
  return modelMessages(input).flatMap(({ content }) => {
    try {
      const value = JSON.parse(content) as unknown;
      if (value === null || typeof value !== "object") return [];
      if (Array.isArray(value)) return [];
      return [value as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

export function recallCapsules(input: RecallModelInput) {
  return jsonMessages(input).filter(({ kind }) => kind === RECALL_KIND);
}

export function responseDecision(policy: RecallPolicy) {
  if (policy === "execution-agent-v1") return { action: "respond" };
  return {
    action: "respond",
    responseRecommendation: "Explain the relevant preference for this request.",
  };
}

export function createMemoryRecallHarness(
  options: Readonly<{
    policy: RecallPolicy;
    decide: (input: RecallModelInput) => unknown | Promise<unknown>;
    enabled?: boolean;
    memoryRecallLimit?: number;
    retrieve?: LongTermMemoryService["retrieve"];
    onInput?: (input: RecallModelInput) => void;
  }>,
) {
  const enabled = options.enabled ?? true;
  const abortController = new AbortController();
  const requestSteering = createRequestSteeringInbox({
    requestId: "memory-recall-request",
  });
  const memory = {
    enabled,
    retrieve: vi.fn<LongTermMemoryService["retrieve"]>(
      options.retrieve ??
        (async () => ({
          available: true,
          records: [MEMORY_RECORD],
        })),
    ),
    processCandidates: vi.fn(),
    scheduleCandidates: vi.fn(),
    status: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  } satisfies LongTermMemoryService;
  const getAdapters = vi.fn(() => []);
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    options.onInput?.(input);
    if (input.modelStep === "supervisor.response") {
      const text = input.format
        ? JSON.stringify({ memoryCandidates: [] })
        : FINAL_RESPONSE;
      return { text, meta: {} };
    }
    if (input.modelStep === "execution.response") {
      const text = enabled
        ? JSON.stringify({
            finalResponse: FINAL_RESPONSE,
            memoryCandidates: [],
          })
        : FINAL_RESPONSE;
      return { text, meta: {} };
    }
    const decision = await options.decide(input);
    const text =
      typeof decision === "string" ? decision : JSON.stringify({ decision });
    return { text, meta: {} };
  });
  const modelSteps = [
    "supervisor.decision",
    "supervisor.response",
    "execution.decision",
    "execution.response",
    "planner.decision",
    "worker.decision",
    "worker.result",
    "reviewer.decision",
  ];
  const request = createTestRequestExecutionScope({
    requestId: "memory-recall-request",
    sessionId: "memory-recall-session",
    prompt: REQUEST_PROMPT,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    requestSteering,
    executionPolicySelection: {
      policy: options.policy,
      primaryProfileId: "test",
      source: "model_profile",
    },
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: Object.fromEntries(
        modelSteps.map((step) => [step, { timeoutMs: 20_000 }]),
      ),
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        test: { provider: "local", model: "test", contextWindowTokens: 32_000 },
      },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw },
    workerCapabilityProvider: {
      getDescriptors: () => [],
      getAdapters,
    },
    longTermMemory: memory,
    ...(options.memoryRecallLimit !== undefined
      ? { memoryRecallLimit: options.memoryRecallLimit }
      : {}),
    toolPermissionMode: "full_access",
    abortSignal: abortController.signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
  return {
    request,
    invoke,
    invokeRaw,
    memory,
    getAdapters,
    requestSteering,
    abortController,
  };
}
