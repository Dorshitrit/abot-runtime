import { describe, expect, test, vi } from "vitest";

import { fetchProviderWithTrace } from "../model-io-trace.js";
import type { ModelProviderAdapter } from "../providers/contracts.js";
import { createModelProviderAdapterRegistry } from "../providers/contracts.js";
import { createProviderEnvelopeFingerprint } from "../providers/envelope-budget.js";
import type { ModelGatewayPolicyConfig } from "../types.js";
import { createChatHandler } from "./chat-handler.js";
import type { GatewayResponse } from "./contracts.js";
import { createInputTokenCountHandler } from "./input-token-count-handler.js";
import { createInputTokenMeasurementStore } from "./input-token-measurements.js";

const PROVIDER_PAYLOAD = Object.freeze({
  messages: [{ role: "user", content: "x".repeat(512) }],
});

const MODEL_POLICY: ModelGatewayPolicyConfig = {
  providers: { measured: { type: "measured-provider" } },
  profiles: {
    measured: {
      provider: "measured",
      model: "measured-model",
      contextWindowTokens: 128,
    },
  },
  defaults: { profileId: "measured" },
};

function createResponse(): {
  response: GatewayResponse;
  readBody(): string;
} {
  let body = "";
  return {
    response: {
      setHeader: vi.fn(),
      write(chunk) {
        body += chunk;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    readBody: () => body,
  };
}

describe("gateway input-token measurement flow", () => {
  test("reuses a counted envelope in chat admission and provider projection", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    const invoke = vi.fn<NonNullable<ModelProviderAdapter["invoke"]>>(
      async (params) => {
        const { response, responseTrace } = await fetchProviderWithTrace({
          endpoint: params.endpoint,
          requestBody: params.requestBody,
          invocation: params.invocation,
          fetchImpl: params.fetchImpl,
          url: "http://provider.test/chat",
          headers: { "Content-Type": "application/json" },
          payload: PROVIDER_PAYLOAD,
          decodeResponse: async () => ({ text: "", thinking: "" }),
        });
        await responseTrace;
        expect(response.ok).toBe(true);
        return {
          kind: "chat",
          async stream(events) {
            events.emit({ type: "done", done: true, doneReason: "stop" });
          },
        };
      },
    );
    const adapter: ModelProviderAdapter = {
      type: "measured-provider",
      supportsImageInput: false,
      async countInputTokens() {
        return {
          kind: "counted",
          inputTokens: 64,
          providerEnvelopeFingerprint:
            createProviderEnvelopeFingerprint(PROVIDER_PAYLOAD),
        };
      },
      invoke,
    };
    const options = {
      fetchImpl: upstreamFetch,
      modelPolicy: MODEL_POLICY,
      providerAdapters: createModelProviderAdapterRegistry([adapter]),
    };
    const measurements = createInputTokenMeasurementStore();
    const countHandler = createInputTokenCountHandler(options, measurements);
    const chatHandler = createChatHandler(options, measurements);
    const requestBody = {
      debugRequestId: "measurement-flow-test",
      modelStep: "execution.decision" as const,
      messages: [{ role: "user", content: "count then invoke" }],
    };

    await countHandler(requestBody, createResponse().response);
    const chatResponse = createResponse();
    await chatHandler(requestBody, chatResponse.response);

    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0].inputTokenMeasurement).toMatchObject({
      inputTokens: 64,
      source: "provider_input_token_count",
    });
    expect(chatResponse.readBody()).toContain('"type":"done"');
  });
});
