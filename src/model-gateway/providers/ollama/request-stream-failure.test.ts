import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFailureHarness } from "../../../runtime/__tests__/support/super-handler-failure-fixture.js";
import { disposeCompositionFixtures } from "../../../runtime/__tests__/support/runtime-composition-fixture.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../../../runtime/observability/debug-logger.js";
import type { ModelGatewayClient } from "../../../runtime/ports.js";
import { invokeModelGatewayWithOptions } from "../../client/chat.js";
import {
  configureModelIoTrace,
  resetModelIoTraceConfig,
} from "../../model-io-trace.js";
import { createChatHandler } from "../../server/chat-handler.js";
import type { GatewayResponse } from "../../server/contracts.js";
import type { ModelGatewayRequest } from "../../types.js";

const PARTIAL_ANSWER = "Partial answer before provider failure.";
const PROVIDER_FAILURE = "Synthetic midstream provider failure";
const FAILURE_EXPLANATION = {
  failureNotice: "Unable to finish the response.",
  nextStep: "Continue in a new request.",
};
const DECISION_FRAME = {
  message: {
    content: JSON.stringify({
      decision: {
        action: "respond",
        responseRecommendation: "Synthetic QA response",
        acknowledgement: "Synthetic QA response",
        title: "Synthetic QA response",
      },
    }),
  },
  done: true,
  done_reason: "stop",
};
const PARTIAL_FRAME = {
  model: "qa-mock",
  message: { role: "assistant", content: PARTIAL_ANSWER },
  done: false,
  prompt_eval_count: 10,
  eval_count: 6,
};

beforeEach(() => {
  configureDebugLogger({ enabled: false });
  configureModelIoTrace({ enabled: false });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetModelIoTraceConfig();
  resetDebugLoggerConfig();
});

function ollamaResponse(frames: readonly Record<string, unknown>[]): Response {
  return new Response(
    frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
    {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    },
  );
}

function gatewayResponseBuffer(): GatewayResponse & { body: string } {
  return {
    body: "",
    statusCode: 200,
    setHeader: vi.fn(),
    write(chunk) {
      this.body += chunk;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}

test.each([
  {
    variant: "official error frame after partial content",
    failureFrames: [PARTIAL_FRAME, { error: PROVIDER_FAILURE }],
    cause: "model_stream_error: ollama_stream_error: " + PROVIDER_FAILURE,
  },
  {
    variant: "EOF after partial content without done",
    failureFrames: [PARTIAL_FRAME],
    cause: "model_stream_error: ollama_stream_missing_terminal",
  },
])(
  "$variant fails the request without saving a partial final answer",
  async ({ failureFrames, cause }) => {
    const harness = await createFailureHarness();
    const responses = [
      [DECISION_FRAME],
      failureFrames,
      [
        {
          message: { content: JSON.stringify(FAILURE_EXPLANATION) },
          done: true,
          done_reason: "stop",
        },
      ],
    ];
    const providerFetch = vi.fn<typeof fetch>(async () => {
      const frames = responses.shift();
      if (!frames) throw new Error("unexpected_extra_provider_invocation");
      return ollamaResponse(frames);
    });
    const chatHandler = createChatHandler({
      modelPolicy: harness.runtimeConfig.models,
      ollamaUrl: "http://mock-ollama.invalid",
      fetchImpl: providerFetch,
    });
    const gatewayRequests: ModelGatewayRequest[] = [];
    const gatewayFetch = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("http://mock-gateway.invalid/chat");
      const body = JSON.parse(String(init?.body)) as ModelGatewayRequest;
      gatewayRequests.push(body);
      const response = gatewayResponseBuffer();
      await chatHandler(body, response, {
        abortSignal: init?.signal ?? undefined,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    });
    vi.stubGlobal("fetch", gatewayFetch);
    const invoke = vi.fn<ModelGatewayClient["invoke"]>((input) =>
      invokeModelGatewayWithOptions(input, {
        baseUrl: "http://mock-gateway.invalid",
      }),
    );

    await harness.run(invoke, {}, { sessionId: "qa", input: "Synthetic QA" });

    expect(gatewayRequests.map((request) => request.modelStep)).toEqual([
      "supervisor.decision",
      "supervisor.response",
      "degraded.finalization",
    ]);
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(responses).toEqual([]);
    expect(harness.events.filter(({ type }) => type === "completed")).toEqual(
      [],
    );
    const failed = harness.events.filter(({ type }) => type === "failed");
    expect(failed).toEqual([
      expect.objectContaining({
        requestId: "failure-request",
        error: cause,
      }),
    ]);
    expect(String(failed[0]!.error)).toContain("model_stream_error:");
    const replay = await harness.sessionStore.getRequestReplayById!(
      "failure-request",
      0,
    );
    expect(replay?.finalState).toMatchObject({
      status: "failed",
      error: failed[0]!.error,
    });
    const explanation = [
      FAILURE_EXPLANATION.failureNotice,
      FAILURE_EXPLANATION.nextStep,
    ].join("\n\n");
    const session = await harness.sessionStore.getSessionById("qa");
    const assistantMessages = session?.messages.filter(
      ({ role }) => role === "assistant",
    );
    expect(assistantMessages).toEqual([
      expect.objectContaining({
        content: explanation,
        requestId: "failure-request",
        grounding: "conversation",
      }),
    ]);
    expect(
      harness.append.mock.calls.filter(([, role]) => role === "assistant"),
    ).toEqual([expect.arrayContaining(["qa", "assistant", explanation])]);
    expect(
      assistantMessages?.some(({ content }) =>
        content.includes(PARTIAL_ANSWER),
      ),
    ).toBe(false);
  },
);
