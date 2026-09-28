import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { fetchProviderWithTrace } from "../observability/provider-trace.js";
import { traceModelIo } from "../observability/trace-store.js";
import type { ModelProviderAdapter } from "../providers/contracts.js";
import type { ModelGatewayRequest } from "../types.js";
import { createChatHandler } from "./chat-handler.js";
import type { GatewayResponse } from "./contracts.js";

vi.mock("../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => true,
  traceModelIo: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "test-only-injected-fetch");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function imageRequest(provider: string, contextWindowTokens: number): ModelGatewayRequest {
  return {
    modelStep: "execution.decision",
    messages: [
      { role: "user", content: "Inspect this observation." },
      { role: "assistant", content: "", toolCalls: [{
        callId: "execution-1", name: "observe", arguments: "{}",
      }] },
      {
        role: "tool", toolCallId: "execution-1", toolName: "observe",
        content: JSON.stringify({ media: [{ kind: "tool_image_v1", id: "private-image-ref" }] }),
        attachments: [{
          id: "private-image-ref", kind: "image", mimeType: "image/png",
          storageRef: "request-tool-media", data: "PRIVATE_PIXELS",
          toolEvidence: { executionId: "execution-1" },
        }],
      },
    ],
    modelPolicy: {
      providers: { fixture: { type: provider } },
      profiles: { fixture: {
        provider: "fixture", model: "fixture", contextWindowTokens,
        capabilities: { inputModalities: ["text", "image"] },
      } },
      defaults: { profileId: "fixture" },
    },
  };
}

function captureResponse(): GatewayResponse & { body: string } {
  return {
    body: "", setHeader() {},
    write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; },
  };
}

function expectPrivateTraces(): void {
  const traces = JSON.stringify(vi.mocked(traceModelIo).mock.calls);
  expect(traces).toContain("contentOmitted");
  expect(traces).not.toContain("PRIVATE_PIXELS");
  expect(traces).not.toContain("private-image-ref");
}

test.each(["openai", "ollama"])(
  "%s tool image admission preserves the gateway 400 context-window response before upstream dispatch",
  async (provider) => {
    const upstreamFetch = vi.fn<typeof fetch>();
    const response = captureResponse();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await createChatHandler({ fetchImpl: upstreamFetch })(imageRequest(provider, 8), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe("model_context_window_exceeded");
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expectPrivateTraces();
  },
);

test("an uninspectable adapter envelope preserves the gateway 400 response without exposing image evidence", async () => {
  const upstreamFetch = vi.fn<typeof fetch>();
  const response = captureResponse();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const malformedAdapter: ModelProviderAdapter = {
    type: "malformed-envelope-fixture", supportsImageInput: true,
    async invoke(params) {
      await fetchProviderWithTrace({
        ...params, url: "http://provider.test/chat", headers: {},
        // An adapter producing JSON that is not an object cannot prove admission.
        payload: { toJSON: () => "PRIVATE_PIXELS private-image-ref" },
        decodeResponse: async () => ({ text: "", thinking: "" }),
      });
      throw new Error("invalid envelope must never reach upstream");
    },
  };

  await createChatHandler({
    fetchImpl: upstreamFetch, additionalProviderAdapters: [malformedAdapter],
  })(imageRequest(malformedAdapter.type, 32_768), response);

  expect(response.statusCode).toBe(400);
  expect(response.body).toBe("model_provider_envelope_uninspectable");
  expect(upstreamFetch).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
  expectPrivateTraces();
});

test("an upstream error containing image evidence remains a redacted gateway 500", async () => {
  const upstreamFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("PRIVATE_PIXELS private-image-ref");
  });
  const response = captureResponse();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  await createChatHandler({ fetchImpl: upstreamFetch })(imageRequest("openai", 32_768), response);

  expect(upstreamFetch).toHaveBeenCalledOnce();
  expect(response.statusCode).toBe(500);
  expect(response.body).toBe("server error");
  expect(consoleError).toHaveBeenCalledWith(new Error("tool_media_provider_error: content omitted"));
  expectPrivateTraces();
});
