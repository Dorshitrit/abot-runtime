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

  test("does not capture a failed response prefix or tail when content tracing is forbidden", async () => {
    let chunks = 0;
    const error = new Error("private stream failure");
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ === 0) controller.enqueue(new TextEncoder().encode("private screen evidence"));
        else controller.error(error);
      },
    }));
    const clone = vi.spyOn(response, "clone");
    const decodeResponse = vi.fn();
    const result = await fetchProviderWithTrace({
      endpoint: "chat", requestBody: { modelStep: "learning.batch" }, invocation,
      fetchImpl: async () => response, url: "http://provider.test/chat", headers: {},
      payload: { input: "private screen evidence" }, decodeResponse,
    });
    await expect(result.response.text()).rejects.toBe(error);
    await result.responseTrace;
    expect(clone).not.toHaveBeenCalled();
    expect(decodeResponse).not.toHaveBeenCalled();
    const events = vi.mocked(traceModelIo).mock.calls.map(([event]) => event);
    expect(events.map((event) => event.event)).toEqual(["provider.request"]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("partialBody");
  });
});
