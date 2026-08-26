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

describe("OpenAI payload input authority", () => {
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
