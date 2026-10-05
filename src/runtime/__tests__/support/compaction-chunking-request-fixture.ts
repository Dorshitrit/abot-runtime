import { vi } from "vitest";
import type { RequestStepInstructionBlock } from "../../config/runner/contracts.js";
import type { ModelGatewayClient } from "../../ports.js";
import {
  CONTEXT_COMPACTION_MODEL_STEP,
  createRequestContextCompactionStore,
} from "../../context/semantic-compaction/index.js";
import { createTestRequestExecutionScope } from "./request-execution-scope.js";
import { withCheckpointTokenMeasurement } from "./semantic-compaction-replacement-fixture.js";

export function createCompactionRequest(
  params: Readonly<{
    requestId: string;
    prompt: string;
    invoke: ModelGatewayClient["invoke"];
    countInputTokens?: ModelGatewayClient["countInputTokens"];
    instructionBlocks?: readonly RequestStepInstructionBlock[];
    store?: ReturnType<typeof createRequestContextCompactionStore>;
    asciiCharactersPerToken?: number;
  }>,
) {
  return createTestRequestExecutionScope({
    requestId: params.requestId,
    sessionId: `${params.requestId}-session`,
    prompt: params.prompt,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: {
      models: {
        defaults: {
          profileId: "compact-test-profile",
          steps: {
            [CONTEXT_COMPACTION_MODEL_STEP]: "compact-test-profile",
          },
        },
      },
      context: {
        outputReserveTokens: 2_048,
        safetyReserveTokens: 500,
        attachmentReserveTokens: 100,
      },
      steps: {
        [CONTEXT_COMPACTION_MODEL_STEP]: {
          timeoutMs: 20_000,
          ...(params.instructionBlocks
            ? { instructionBlocks: params.instructionBlocks }
            : {}),
        },
      },
    },
    agentMode: "reasoning",
    modelPolicy: {
      providers: { test: { type: "ollama" } },
      profiles: {
        "compact-test-profile": {
          provider: "test",
          model: "compact-test-model",
          contextWindowTokens: 16_000,
          ...(params.asciiCharactersPerToken
            ? {
                context: {
                  tokenEstimation: {
                    asciiCharactersPerToken: params.asciiCharactersPerToken,
                    nonAsciiBytesPerToken: 2,
                    messageOverheadTokens: 6,
                  },
                },
              }
            : {}),
        },
      },
      defaults: {
        profileId: "compact-test-profile",
        steps: {
          [CONTEXT_COMPACTION_MODEL_STEP]: "compact-test-profile",
        },
      },
    },
    modelGatewayClient: {
      invoke: params.invoke,
      invokeRaw: vi.fn(),
      ...(params.countInputTokens
        ? {
            countInputTokens: withCheckpointTokenMeasurement(
              params.countInputTokens,
            ),
          }
        : {}),
    },
    ...(params.store ? { contextCompactionStore: params.store } : {}),
    abortSignal: new AbortController().signal,
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onAnswerToken: vi.fn(),
    onEvent: vi.fn(),
  });
}
