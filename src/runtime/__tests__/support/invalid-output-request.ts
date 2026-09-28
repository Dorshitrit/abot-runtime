import { vi } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelGatewayClient } from "../../ports.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";

export type InvalidOutputModelInput = Parameters<
  ModelGatewayClient["invoke"]
>[0];

export function createInvalidOutputRequest(
  invoke: ModelGatewayClient["invoke"],
) {
  return createTestRequestExecutionScope({
    requestId: "invalid-output-child-request",
    sessionId: "invalid-output-child-session",
    prompt: "Produce a bounded report and independently review its result.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: { defaults: { profileId: "test", steps: {} } },
      context: {
        outputReserveTokens: 1_000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      steps: Object.fromEntries(
        [
          "supervisor.decision",
          "planner.decision",
          "worker.decision",
          "worker.result",
          "reviewer.decision",
          "supervisor.response",
        ].map((step) => [step, { timeoutMs: 20_000 }]),
      ),
    },
    agentMode: "reasoning",
    toolPermissionMode: "full_access",
    modelPolicy: {
      providers: { local: { type: "ollama" } },
      profiles: {
        test: { provider: "local", model: "test", contextWindowTokens: 64_000 },
      },
      defaults: { profileId: "test", steps: {} },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}

export function readInvalidOutputCapsules(
  input: InvalidOutputModelInput,
  kind: string,
): Record<string, any>[] {
  const messages = input.messages as readonly ChatMessage[] | undefined;
  return (messages ?? []).flatMap((message) => {
    try {
      const value = JSON.parse(message.content);
      return value.kind === kind ? [value] : [];
    } catch {
      return [];
    }
  });
}
