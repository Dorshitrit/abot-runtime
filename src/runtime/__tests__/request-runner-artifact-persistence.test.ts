import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ModelGatewayClient } from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const mocks = vi.hoisted(() => ({
  persistSettledSessionArtifactPaths: vi.fn(),
}));

vi.mock(
  "../request/session-artifact-path-persistence.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../request/session-artifact-path-persistence.js")
      >();
    return {
      ...actual,
      persistSettledSessionArtifactPaths:
        mocks.persistSettledSessionArtifactPaths,
    };
  },
);

const { runRequestRunner } = await import("../request/runner.js");

const runnerConfig: RequestRunnerConfig = {
  models: {
    defaults: {
      profileId: "runner-persistence-test",
      steps: {
        "supervisor.decision": "supervisor.decision",
        "supervisor.response": "supervisor.response",
      },
    },
  },
  context: {
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
  steps: {
    "supervisor.decision": { timeoutMs: 20_000 },
    "supervisor.response": { timeoutMs: 20_000 },
  },
};

const modelPolicy: NonNullable<RequestExecutionScope["modelPolicy"]> = {
  providers: {
    "runner-persistence-provider": {
      type: "ollama",
    },
  },
  profiles: {
    "runner-persistence-test": {
      provider: "runner-persistence-provider",
      model: "runner-persistence-model",
      contextWindowTokens: 8_000,
    },
  },
  defaults: {
    profileId: "runner-persistence-test",
  },
};

function createRequest(
  invoke: ModelGatewayClient["invoke"],
  onAnswerToken = vi.fn(),
): RequestExecutionScope {
  return createTestRequestExecutionScope({
    requestId: "runner-persistence-request",
    sessionId: "runner-persistence-session",
    prompt: "Return one bounded response.",
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    contextCompactionStore: createRequestContextCompactionStore(),
    runnerConfig,
    agentMode: "reasoning",
    modelPolicy,
    modelGatewayClient: {
      invoke,
      invokeRaw: vi.fn(),
    },
    workerCapabilityProvider: {
      getDescriptors: () => Object.freeze([]),
      getAdapters: () => Object.freeze([]),
    },
    toolPermissionMode: "full_access",
    abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(),
    onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(),
    onThinkingTrace: vi.fn(),
    onAnswerToken,
    onEvent: vi.fn(),
  });
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
  mocks.persistSettledSessionArtifactPaths.mockReset();
});

afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("request runner artifact-path persistence sequencing", () => {
  test("persists the final ledger before delivering a successful answer", async () => {
    const order: string[] = [];
    mocks.persistSettledSessionArtifactPaths.mockImplementation(async () => {
      order.push("persist");
    });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async ({ modelStep }) =>
      modelStep === "supervisor.decision"
        ? {
            text: JSON.stringify({
              decision: {
                action: "respond",
                acknowledgement: "I understand and will answer directly.",
              },
            }),
            meta: {},
          }
        : { text: "Bounded response.", meta: {} },
    );
    const onAnswerToken = vi.fn(() => {
      order.push("answer");
    });
    const request = createRequest(invoke, onAnswerToken);
    const persistArtifactPaths = vi.fn(async () => undefined);

    await expect(
      runRequestRunner(request, { persistArtifactPaths }),
    ).resolves.toEqual({ output: "Bounded response." });

    expect(order).toEqual(["persist", "answer"]);
    expect(mocks.persistSettledSessionArtifactPaths).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: request.sessionId,
        trigger: "root_succeeded",
        persistArtifactPaths,
      }),
    );
    expect(
      mocks.persistSettledSessionArtifactPaths.mock.calls[0]?.[0].head.state
        .phase,
    ).toBe("completed");
  });

  test("attempts persistence before propagating the original root failure", async () => {
    const order: string[] = [];
    mocks.persistSettledSessionArtifactPaths.mockImplementation(async () => {
      order.push("persist");
    });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
      order.push("root_failure");
      throw new Error("primary_root_failure");
    });
    const onAnswerToken = vi.fn(() => {
      order.push("answer");
    });
    const request = createRequest(invoke, onAnswerToken);

    await expect(runRequestRunner(request)).rejects.toThrow(
      "primary_root_failure",
    );

    expect(order).toEqual(["root_failure", "persist"]);
    expect(mocks.persistSettledSessionArtifactPaths).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: request.sessionId,
        trigger: "root_failed",
      }),
    );
    expect(onAnswerToken).not.toHaveBeenCalled();
  });
});
