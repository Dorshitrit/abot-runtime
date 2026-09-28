import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../invocation-policy.js";
import { fetchProviderWithTrace } from "./provider-trace.js";
import { traceModelIo } from "./trace-store.js";

vi.mock("./trace-store.js", () => ({
  isModelIoTraceEnabled: () => true,
  traceModelIo: vi.fn(async () => {}),
}));
beforeEach(() => vi.clearAllMocks());

const invocation = resolveModelInvocation({
  modelStep: "supervisor.decision",
  modelPolicy: {
    providers: { ollama: { type: "ollama" } },
    profiles: {
      local: {
        provider: "ollama",
        model: "fixture",
        contextWindowTokens: 32768,
      },
    },
    defaults: { profileId: "local" },
  },
});

describe("passive observation model trace policy", () => {
  test("does not persist screen content or clone model output, while provider receives it intact", async () => {
    const payload = {
      messages: [{ role: "system", content: "private screen evidence" }],
    };
    const response = new Response("private learned fact");
    const clone = vi.spyOn(response, "clone");
    const fetchImpl = vi.fn(async () => response);
    const result = await fetchProviderWithTrace({
      endpoint: "chat",
      requestBody: { modelStep: "learning.batch" },
      invocation,
      fetchImpl,
      url: "http://provider.test/chat",
      headers: {},
      payload,
      decodeResponse: async () => ({
        text: "private learned fact",
        thinking: "private reasoning",
      }),
    });
    await result.responseTrace;
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://provider.test/chat",
      expect.objectContaining({ body: JSON.stringify(payload) }),
    );
    expect(clone).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(traceModelIo).mock.calls)).not.toContain(
      "private",
    );
    expect(traceModelIo).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          body: {
            contentOmitted: true,
            byteLength: Buffer.byteLength(JSON.stringify(payload)),
          },
        }),
      }),
    );
  });

  test("ordinary model steps preserve the existing trace contract", async () => {
    const payload = {
      messages: [{ role: "user", content: "ordinary content" }],
    };
    const result = await fetchProviderWithTrace({
      endpoint: "chat",
      requestBody: { modelStep: "supervisor.decision" },
      invocation,
      fetchImpl: async () => new Response("answer"),
      url: "http://provider.test/chat",
      headers: {},
      payload,
      decodeResponse: async () => ({ text: "answer", thinking: "" }),
    });
    await result.responseTrace;
    expect(traceModelIo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "provider.request",
        request: expect.objectContaining({ body: payload }),
      }),
    );
    expect(traceModelIo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "provider.response" }),
    );
  });
});
