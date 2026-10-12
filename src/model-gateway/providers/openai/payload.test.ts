import { describe, expect, test } from "vitest";

import type { ModelGatewayRequest } from "../../types.js";
import {
  buildOpenAIInputTokenCountPayload,
  buildOpenAIResponsesPayload,
} from "./payload.js";

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

});
