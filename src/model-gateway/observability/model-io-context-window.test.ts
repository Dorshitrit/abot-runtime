import { describe, expect, test, vi } from "vitest";

import { createContextWindowGuardedProviderFetch } from "../model-io-trace.js";
import {
  createProviderEnvelopeFingerprint,
  estimateProviderEnvelopeInputTokens,
} from "../provider-envelope-budget.js";
import type { ModelProviderInputTokenMeasurement } from "../provider-adapter.js";
import { resolveModelInvocation } from "../invocation-policy.js";
import type { ModelGatewayRequest } from "../types.js";

function createGuard(params: {
  contextWindowTokens: number;
  fetchImpl: typeof fetch;
  inputTokenMeasurement?: ModelProviderInputTokenMeasurement;
}): typeof fetch {
  const requestBody: ModelGatewayRequest = {
    debugRequestId: "context-window-guard-test",
    modelStep: "worker.decision",
    modelPolicy: {
      providers: {
        local: { type: "ollama" },
      },
      profiles: {
        test: {
          provider: "local",
          model: "test-model",
          contextWindowTokens: params.contextWindowTokens,
        },
      },
      defaults: {
        profileId: "test",
      },
    },
  };
  return createContextWindowGuardedProviderFetch({
    endpoint: "chat",
    requestBody,
    invocation: resolveModelInvocation(requestBody),
    fetchImpl: params.fetchImpl,
    ...(params.inputTokenMeasurement
      ? { inputTokenMeasurement: params.inputTokenMeasurement }
      : {}),
  });
}

describe("provider context-window fetch guard", () => {
  test("forwards an inspectable JSON envelope within the context window", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchImpl = vi.fn(async () => response);
    const guardedFetch = createGuard({
      contextWindowTokens: 1_024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const input = "http://provider.test/chat";
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    };

    await expect(guardedFetch(input, init)).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(input, init);
  });

  test("rejects an envelope above contextWindowTokens before fetch", async () => {
    const fetchImpl = vi.fn();
    const guardedFetch = createGuard({
      contextWindowTokens: 8,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      guardedFetch("http://provider.test/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "x".repeat(512) }],
        }),
      }),
    ).rejects.toThrow("model_context_window_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("uses an exact provider count bound to the final envelope", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchImpl = vi.fn(async () => response);
    const payload = {
      messages: [{ role: "user", content: "x".repeat(512) }],
    };
    const guardedFetch = createGuard({
      contextWindowTokens: 128,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      inputTokenMeasurement: {
        inputTokens: 64,
        providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(payload),
        source: "provider_input_token_count",
      },
    });

    await expect(
      guardedFetch("http://provider.test/chat", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    ).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("does not trust an exact count for a different envelope", async () => {
    const fetchImpl = vi.fn();
    const guardedFetch = createGuard({
      contextWindowTokens: 128,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      inputTokenMeasurement: {
        inputTokens: 64,
        providerEnvelopeFingerprint: createProviderEnvelopeFingerprint({
          messages: [{ role: "user", content: "different" }],
        }),
        source: "provider_input_token_count",
      },
    });

    await expect(
      guardedFetch("http://provider.test/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "x".repeat(512) }],
        }),
      }),
    ).rejects.toThrow("model_context_window_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("reserves at least one physical token for provider output", async () => {
    const fetchImpl = vi.fn();
    const payload = {
      messages: [{ role: "user", content: "exactly full" }],
    };
    const guardedFetch = createGuard({
      contextWindowTokens: estimateProviderEnvelopeInputTokens(payload),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      guardedFetch("http://provider.test/chat", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    ).rejects.toThrow("model_context_window_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects a non-JSON provider body before fetch", async () => {
    const fetchImpl = vi.fn();
    const guardedFetch = createGuard({
      contextWindowTokens: 1_024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      guardedFetch("http://provider.test/chat", {
        method: "POST",
        body: "not-json",
      }),
    ).rejects.toThrow("model_provider_envelope_uninspectable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
