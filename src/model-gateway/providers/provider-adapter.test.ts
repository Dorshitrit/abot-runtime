import { describe, expect, test, vi } from "vitest";

import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
} from "../provider-adapter.js";
import {
  createChatHandler,
  createInputTokenCountHandler,
  type GatewayResponse,
} from "../server.js";

function createResponse(): GatewayResponse & { body: string } {
  return {
    body: "",
    setHeader: vi.fn(),
    write(chunk) {
      this.body += chunk;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}

const CUSTOM_POLICY = {
  providers: {
    local: { type: "custom-protocol", settings: { transport: "fixture" } },
  },
  profiles: {
    custom: {
      provider: "local",
      model: "custom-model",
      contextWindowTokens: 32_768,
    },
  },
  defaults: { profileId: "custom" },
} as const;

describe("model provider adapter registry", () => {
  test("routes a configured provider through an injected adapter", async () => {
    const invoke = vi.fn<ModelProviderAdapter["invoke"]>(async (params) => ({
      kind: "chat",
      async stream(events) {
        events.emit({ type: "content", text: params.invocation.model });
      },
    }));
    const handler = createChatHandler({
      modelPolicy: CUSTOM_POLICY,
      providerAdapters: createModelProviderAdapterRegistry([
        {
          type: "custom-protocol",
          supportsImageInput: false,
          invoke,
        },
      ]),
    });
    const response = createResponse();

    await handler({ text: "hello" }, response);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      endpoint: "chat",
      invocation: {
        model: "custom-model",
        profile: { provider: "custom-protocol" },
      },
    });
    expect(response.body).toContain('"text":"custom-model"');
  });

  test("fails explicitly when no adapter owns the configured provider", async () => {
    const handler = createChatHandler({
      modelPolicy: CUSTOM_POLICY,
      providerAdapters: createModelProviderAdapterRegistry([]),
    });
    const response = createResponse();

    await handler({ text: "hello" }, response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(
      "unknown_model_provider_adapter: custom-protocol",
    );
  });

  test("routes input token counting through the selected provider capability", async () => {
    const countInputTokens = vi.fn<
      NonNullable<ModelProviderAdapter["countInputTokens"]>
    >(async () => ({
      kind: "counted",
      inputTokens: 321,
      providerEnvelopeFingerprint: "sha256:fixture",
    }));
    const handler = createInputTokenCountHandler({
      modelPolicy: CUSTOM_POLICY,
      providerAdapters: createModelProviderAdapterRegistry([
        {
          type: "custom-protocol",
          supportsImageInput: false,
          countInputTokens,
          invoke: async () => ({ kind: "raw", body: {} }),
        },
      ]),
    });
    const response = createResponse();

    await handler({ text: "hello" }, response);

    expect(countInputTokens).toHaveBeenCalledOnce();
    expect(JSON.parse(response.body)).toEqual({
      inputTokens: 321,
      profileId: "custom",
      provider: "custom-protocol",
      model: "custom-model",
      contextWindowTokens: 32_768,
      source: "provider_input_token_count",
    });
  });

  test("keeps providers without a counter explicitly unsupported", async () => {
    const handler = createInputTokenCountHandler({
      modelPolicy: CUSTOM_POLICY,
      providerAdapters: createModelProviderAdapterRegistry([
        {
          type: "custom-protocol",
          supportsImageInput: false,
          invoke: async () => ({ kind: "raw", body: {} }),
        },
      ]),
    });
    const response = createResponse();

    await handler({ text: "hello" }, response);

    expect(response.statusCode).toBe(501);
    expect(response.body).toBe("model_provider_input_token_count_unsupported");
  });

  test("rejects duplicate adapter ownership", () => {
    const adapter: ModelProviderAdapter = {
      type: "fixture",
      supportsImageInput: false,
      invoke: async () => ({ kind: "raw", body: {} }),
    };
    expect(() =>
      createModelProviderAdapterRegistry([adapter, adapter]),
    ).toThrow("model_provider_adapter_duplicate:fixture");
  });
});
