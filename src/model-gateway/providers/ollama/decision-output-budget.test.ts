import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createModelGatewayClient } from "../../client.js";
import { createChatHandler } from "../../server/chat-handler.js";
import type { GatewayResponse } from "../../server/contracts.js";
import type { ModelGatewayRequest } from "../../types.js";
import { estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";
import {
  ModelOutputIncompleteError,
  resolveOutputIncompleteError,
} from "../../../runtime/model/provider-completion.js";

vi.mock("../../../runtime/observability/debug-logger.js", () => ({
  traceDebug: vi.fn(),
}));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => false,
  traceModelIo: vi.fn(async () => {}),
}));

const CONTEXT_TOKENS = 32_768;
const TOKEN_ESTIMATION = {
  asciiCharactersPerToken: 4,
  nonAsciiBytesPerToken: 2,
  messageOverheadTokens: 6,
};
const POLICY = {
  providers: { local: { type: "ollama" } },
  profiles: {
    fixture: {
      provider: "local",
      model: "reasoning-budget-fixture",
      contextWindowTokens: CONTEXT_TOKENS,
      supportsThinking: true,
      context: { tokenEstimation: TOKEN_ESTIMATION },
    },
  },
  defaults: { profileId: "fixture" },
} as const;
const DECISION = JSON.stringify({
  decision: {
    action: "respond",
    response: "Ready.",
    memoryCandidates: [],
    title: "Ready",
  },
});
const THINKING = "Synthetic reasoning fixture. ".repeat(500);

function providerWire(ending: "stop" | "length"): string {
  const midpoint = Math.floor(THINKING.length / 2);
  return [
    { message: { thinking: THINKING.slice(0, midpoint) }, done: false },
    { message: { thinking: THINKING.slice(midpoint) }, done: false },
    {
      message: {
        content: ending === "stop" ? DECISION : DECISION.slice(0, -4),
      },
      done: false,
    },
    {
      done: true,
      done_reason: ending,
      prompt_eval_count: 120,
      eval_count: ending === "stop" ? 3_100 : 2_048,
    },
  ]
    .map((frame) => `${JSON.stringify(frame)}\n`)
    .join("");
}

function captureGatewayResponse(): GatewayResponse & {
  chunks: string[];
  headers: Headers;
} {
  const chunks: string[] = [];
  const headers = new Headers();
  return {
    chunks,
    headers,
    setHeader: (name, value) => headers.set(name, value),
    write: (chunk) => {
      chunks.push(chunk);
    },
    end: (chunk) => {
      if (chunk) chunks.push(chunk);
    },
  };
}

async function invokeDecision(ending: "stop" | "length") {
  const providerFetch = vi.fn<typeof fetch>(
    async () => new Response(providerWire(ending)),
  );
  const handler = createChatHandler({
    modelPolicy: POLICY,
    fetchImpl: providerFetch,
  });
  const gatewayFetch = vi.fn<typeof fetch>(async (_input, init) => {
    const response = captureGatewayResponse();
    const request = JSON.parse(String(init?.body)) as ModelGatewayRequest;
    await handler(request, response);
    return new Response(response.chunks.join(""), {
      status: response.statusCode ?? 200,
      headers: response.headers,
    });
  });
  vi.stubGlobal("fetch", gatewayFetch);
  const thinking: string[] = [];
  const result = await createModelGatewayClient({
    baseUrl: "http://gateway-fixture.test",
  }).invoke({
    text: "Choose the next action.",
    modelStep: "execution.decision",
    agentMode: "deep",
    format: "json",
    abortSignal: new AbortController().signal,
    onThinking: (text) => {
      thinking.push(text);
    },
  });
  const payload = JSON.parse(String(providerFetch.mock.calls[0]?.[1]?.body));
  const incomplete = resolveOutputIncompleteError(
    {
      outputLength: result.text.length,
      providerCompletionReason: result.meta.providerCompletionReason,
      providerInputTokens: result.meta.usage?.inputTokens,
      providerOutputTokens: result.meta.usage?.outputTokens,
      providerTotalTokens: result.meta.usage?.totalTokens,
    },
    "execution.decision",
  );
  return { result, payload, thinking, incomplete, providerFetch, gatewayFetch };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OLLAMA_NUM_PREDICT", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Ollama decision generation through gateway transport", () => {
  test("preserves a complete decision after reasoning exceeds the former decision allowance", async () => {
    const {
      result,
      payload,
      thinking,
      incomplete,
      providerFetch,
      gatewayFetch,
    } = await invokeDecision("stop");
    const remainder =
      CONTEXT_TOKENS -
      estimateProviderEnvelopeInputTokens(payload, TOKEN_ESTIMATION);

    expect(remainder).toBeGreaterThan(3_100);
    expect(payload).toMatchObject({
      think: "high",
      options: { num_predict: remainder },
    });
    expect(result.text).toBe(DECISION);
    expect(JSON.parse(result.text).decision.action).toBe("respond");
    expect(thinking.join("")).toBe(THINKING);
    expect(result.meta).toMatchObject({
      terminalEventCount: 1,
      providerCompletionReason: "stop",
      usage: { inputTokens: 120, outputTokens: 3_100, totalTokens: 3_220 },
    });
    expect(incomplete).toBeUndefined();
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(gatewayFetch).toHaveBeenCalledOnce();
  });

  test("retains a genuine provider length termination as a typed incomplete decision", async () => {
    const { result, incomplete, providerFetch, gatewayFetch } =
      await invokeDecision("length");

    expect(result.text).toBe(DECISION.slice(0, -4));
    expect(result.meta.providerCompletionReason).toBe("length");
    expect(incomplete).toBeInstanceOf(ModelOutputIncompleteError);
    expect(incomplete).toMatchObject({
      code: "output_incomplete",
      modelStep: "execution.decision",
      providerCompletionReason: "length",
      providerOutputTokens: 2_048,
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(gatewayFetch).toHaveBeenCalledOnce();
  });
});
