import { describe, expect, test } from "vitest";

import { resolveModelInvocation } from "../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../types.js";
import { createInputTokenMeasurementStore } from "./input-token-measurements.js";

function createRequest(content: string): ModelGatewayRequest {
  return {
    debugRequestId: "measurement-store-test",
    modelStep: "execution.decision",
    messages: [{ role: "user", content }],
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

describe("input token measurement store", () => {
  test("resolves a provider measurement only for the same request binding", () => {
    const store = createInputTokenMeasurementStore();
    const requestBody = createRequest("same envelope");
    const invocation = resolveModelInvocation(requestBody);

    store.record(
      { requestBody, invocation },
      {
        kind: "counted",
        inputTokens: 85_653,
        providerEnvelopeFingerprint: "sha256:matching-envelope",
      },
    );

    expect(store.resolve({ requestBody, invocation })).toEqual({
      inputTokens: 85_653,
      providerEnvelopeFingerprint: "sha256:matching-envelope",
      source: "provider_input_token_count",
    });
    const differentRequest = createRequest("different envelope");
    expect(
      store.resolve({
        requestBody: differentRequest,
        invocation: resolveModelInvocation(differentRequest),
      }),
    ).toBeUndefined();
  });

  test("expires measurements instead of retaining stale authority", () => {
    let currentTime = 1_000;
    const store = createInputTokenMeasurementStore({
      now: () => currentTime,
      ttlMs: 100,
    });
    const requestBody = createRequest("expiring envelope");
    const invocation = resolveModelInvocation(requestBody);
    store.record(
      { requestBody, invocation },
      {
        kind: "counted",
        inputTokens: 100,
        providerEnvelopeFingerprint: "sha256:expiring-envelope",
      },
    );

    currentTime = 1_100;

    expect(store.resolve({ requestBody, invocation })).toBeUndefined();
  });
});
