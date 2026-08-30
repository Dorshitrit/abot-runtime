import { describe, expect, test } from "vitest";

import type { ModelGatewayRequest } from "../../types.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import {
  buildOpenAIInputTokenCountPayload,
  buildOpenAIResponsesPayload,
} from "./payload.js";

function createLargeDecisionRequest(): ModelGatewayRequest {
  return {
    modelStep: "execution.decision",
    messages: [{ role: "user", content: "x".repeat(520_000) }],
    modelPolicy: {
      providers: { remote: { type: "openai" } },
      profiles: {
        luna: {
          provider: "remote",
          model: "gpt-test-luna",
          contextWindowTokens: 128_000,
        },
      },
      defaults: { profileId: "luna" },
    },
  };
}

function createCalibratedReasoningNoneRequest(): ModelGatewayRequest {
  return {
    agentMode: "deep",
    modelStep: "tool_payload.raw",
    messages: [{ role: "user", content: "Return the literal payload." }],
    modelPolicy: {
      providers: { remote: { type: "openai" } },
      profiles: {
        luna: {
          provider: "remote",
          model: "gpt-test-luna",
          contextWindowTokens: 128_000,
          supportsThinking: true,
          generation: { temperature: 0.2, topP: 0.9 },
          calibration: {
            "toolPayload.raw": {
              generation: { reasoningEffort: "none" },
            },
          },
        },
      },
      defaults: {
        profileId: "luna",
        steps: { "tool_payload.raw": "toolPayload.raw" },
      },
    },
  };
}

describe("OpenAI payload input authority", () => {
  test("projects calibrated none as explicit provider reasoning", () => {
    const payload = buildOpenAIResponsesPayload(
      createCalibratedReasoningNoneRequest(),
    );

    expect(payload.reasoning).toEqual({ effort: "none" });
    expect(payload.temperature).toBe(0.2);
    expect(payload.top_p).toBe(0.9);
  });

  test("retains explicit none in the input-token payload", () => {
    const payload = buildOpenAIInputTokenCountPayload(
      createCalibratedReasoningNoneRequest(),
    );

    expect(payload.reasoning).toEqual({ effort: "none" });
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
  });

  test("uses the bound provider count for physical decision headroom", () => {
    const requestBody = createLargeDecisionRequest();
    const countPayload = buildOpenAIInputTokenCountPayload(requestBody);
    const payload = buildOpenAIResponsesPayload(requestBody, {
      inputTokenMeasurement: {
        inputTokens: 85_653,
        providerEnvelopeFingerprint:
          createProviderEnvelopeFingerprint(countPayload),
        source: "provider_input_token_count",
      },
    });

    expect(payload.max_output_tokens).toBe(2_048);
  });

  test("keeps the estimator fallback when no provider count is available", () => {
    const payload = buildOpenAIResponsesPayload(createLargeDecisionRequest());

    expect(payload.max_output_tokens).toBe(1);
  });
});
