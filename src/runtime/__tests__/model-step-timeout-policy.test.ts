import { describe, expect, test } from "vitest";

import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { resolveModelStepTimeout } from "../model/model-step-timeout-policy.js";

const modelPolicy: ModelGatewayPolicyConfig = {
  profiles: {
    gemma: {
      model: "gemma",
    },
    gpt: {
      model: "gpt-5.6-terra",
      calibration: {
        "toolPayload.raw": {
          timeoutMs: 180_000,
        },
      },
    },
  },
  defaults: {
    profileId: "gemma",
    steps: {
      "tool_payload.raw": "toolPayload.raw",
    },
  },
};

describe("resolveModelStepTimeout", () => {
  test("uses the selected model calibration for the mapped semantic step", () => {
    expect(
      resolveModelStepTimeout({
        modelStep: "tool_payload.raw",
        fallbackTimeoutMs: 90_000,
        modelPreference: { profileId: "gpt", scope: "all" },
        modelPolicy,
      }),
    ).toEqual({
      timeoutMs: 180_000,
      source: "model_calibration",
      selectedProfileId: "gpt",
      calibrationSlotId: "toolPayload.raw",
    });
  });

  test("keeps the runner timeout when the selected model has no override", () => {
    expect(
      resolveModelStepTimeout({
        modelStep: "tool_payload.raw",
        fallbackTimeoutMs: 90_000,
        modelPolicy,
      }),
    ).toEqual({
      timeoutMs: 90_000,
      source: "runner",
      selectedProfileId: "gemma",
    });
  });
});
