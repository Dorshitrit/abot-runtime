import { describe, expect, test, vi } from "vitest";

import type { ModelProviderAdapter } from "../providers/contracts.js";
import { createModelProviderAdapterRegistry } from "../providers/contracts.js";
import {
  createProviderEnvelopeFingerprint,
  estimateProviderEnvelopeInputTokens,
  resolveProviderEnvelopeInputTokens,
} from "../providers/envelope-budget.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGatewayRequest,
} from "../types.js";
import { createChatHandler } from "./chat-handler.js";
import type { GatewayResponse } from "./contracts.js";
import { createInputTokenCountHandler } from "./input-token-count-handler.js";
import { createInputTokenMeasurementStore } from "./input-token-measurements.js";
import { readJsonBody } from "./request-body.js";
import { createChunkedJsonRequest } from "./__tests__/support/chunked-json-request.js";

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

function createMeasuredRequestFlow() {
  const upstreamFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
  const assessEnvelope = vi.fn(resolveProviderEnvelopeInputTokens);
  const countInputTokens = vi.fn<
    NonNullable<ModelProviderAdapter["countInputTokens"]>
  >(async ({ requestBody }) => ({
    kind: "counted",
    inputTokens: 64,
    providerEnvelopeFingerprint: createProviderEnvelopeFingerprint({
      messages: requestBody.messages,
    }),
  }));
  const invoke = vi.fn<ModelProviderAdapter["invoke"]>(async (params) => {
    const payload = { messages: params.requestBody.messages };
    assessEnvelope({
      payload,
      ...(params.inputTokenMeasurement
        ? { measurement: params.inputTokenMeasurement }
        : {}),
    });
    await params.fetchImpl("http://provider.test/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return {
      kind: "chat",
      async stream(events) {
        events.emit({ type: "done", done: true, doneReason: "stop" });
      },
    };
  });
  const options = {
    fetchImpl: upstreamFetch,
    modelPolicy: MODEL_POLICY,
    providerAdapters: createModelProviderAdapterRegistry([
      {
        type: "measured-provider",
        supportsImageInput: false,
        countInputTokens,
        invoke,
      },
    ]),
  };
  const measurements = createInputTokenMeasurementStore();
  return {
    upstreamFetch,
    assessEnvelope,
    countInputTokens,
    invoke,
    countHandler: createInputTokenCountHandler(options, measurements),
    chatHandler: createChatHandler(options, measurements),
  };
}

function createUnicodeRequestBody(): ModelGatewayRequest {
  return {
    debugRequestId: "measurement-flow-test",
    modelStep: "execution.decision",
    messages: [{ role: "user", content: "שלום 🧪 ".repeat(128) }],
  };
}

async function readUnicodeRequest(
  body: ModelGatewayRequest,
  characterByteOffset: number,
): Promise<ModelGatewayRequest> {
  const bytes = Buffer.from(JSON.stringify(body));
  const hebrewStart = bytes.indexOf(Buffer.from("שלום"));
  return readJsonBody(
    createChunkedJsonRequest(body, [hebrewStart + characterByteOffset]),
  );
}

describe("gateway input-token measurement flow", () => {
  test("preserves counted Unicode across different HTTP chunk boundaries", async () => {
    const flow = createMeasuredRequestFlow();
    const originalRequest = createUnicodeRequestBody();
    const countRequest = await readUnicodeRequest(originalRequest, 1);
    const chatRequest = await readUnicodeRequest(originalRequest, 3);
    const countResponse = createResponse();
    const chatResponse = createResponse();

    await flow.countHandler(countRequest, countResponse.response);
    await flow.chatHandler(chatRequest, chatResponse.response);

    expect(flow.upstreamFetch).toHaveBeenCalledOnce();
    expect(countRequest).toEqual(originalRequest);
    expect(chatRequest).toEqual(originalRequest);
    expect(countResponse.response.statusCode).toBe(200);
    expect(
      estimateProviderEnvelopeInputTokens({
        messages: originalRequest.messages,
      }),
    ).toBeGreaterThan(128);
    expect(
      flow.countInputTokens.mock.calls[0]?.[0].requestBody.messages,
    ).toEqual(originalRequest.messages);
    expect(flow.assessEnvelope).toHaveReturnedWith({
      inputTokens: 64,
      measurement: "actual",
      source: "provider_input_token_count",
      measurementBinding: "matched",
    });
    expect(flow.invoke.mock.calls[0]?.[0].inputTokenMeasurement).toMatchObject({
      inputTokens: 64,
      source: "provider_input_token_count",
    });
    const dispatchedBody = flow.upstreamFetch.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(dispatchedBody))).toEqual({
      messages: originalRequest.messages,
    });
    expect(chatResponse.readBody()).toContain('"type":"done"');
  });

  test("rejects changed Unicode content without reusing the earlier count", async () => {
    const flow = createMeasuredRequestFlow();
    const originalRequest = createUnicodeRequestBody();
    const changedRequest: ModelGatewayRequest = {
      ...originalRequest,
      messages: [{ role: "user", content: "שלום 🧪 שינוי ".repeat(128) }],
    };
    const countRequest = await readUnicodeRequest(originalRequest, 1);
    const chatRequest = await readUnicodeRequest(changedRequest, 3);
    const chatResponse = createResponse();

    await flow.countHandler(countRequest, createResponse().response);
    await flow.chatHandler(chatRequest, chatResponse.response);

    expect(countRequest).toEqual(originalRequest);
    expect(chatRequest).toEqual(changedRequest);
    expect(flow.invoke).toHaveBeenCalledOnce();
    expect(
      flow.invoke.mock.calls[0]?.[0].inputTokenMeasurement,
    ).toBeUndefined();
    expect(flow.assessEnvelope).toHaveReturnedWith(
      expect.objectContaining({
        measurement: "estimated",
        measurementBinding: "missing",
      }),
    );
    expect(flow.upstreamFetch).not.toHaveBeenCalled();
    expect(chatResponse.response.statusCode).toBe(400);
    expect(chatResponse.readBody()).toBe("model_context_window_exceeded");
  });
});
