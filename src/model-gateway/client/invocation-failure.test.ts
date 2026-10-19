import { afterEach, expect, test, vi } from "vitest";
import { invokeModelGatewayWithOptions } from "./chat.js";
import type { InvokeModelGatewayParams } from "./contracts.js";
import { ModelGatewayInvocationError } from "./invocation-error.js";
import { InactivityBoundStreamReader } from "./stream-consumer.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({
  traceDebug: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function invoke(overrides: Partial<InvokeModelGatewayParams> = {}) {
  return invokeModelGatewayWithOptions(
    {
      text: "Produce the selected decision.",
      agentMode: "reasoning",
      modelStep: "worker.decision",
      abortSignal: new AbortController().signal,
      ...overrides,
    },
    { baseUrl: "http://gateway.test" },
  );
}

function framesResponse(frames: readonly Record<string, unknown>[]) {
  return new Response(frames.map((frame) => JSON.stringify(frame)).join("\n"));
}

test("a network failure remains diagnostic and does not retry", async () => {
  const cause = new TypeError("fetch failed: connection refused");
  const fetchMock = vi.fn().mockRejectedValue(cause);
  vi.stubGlobal("fetch", fetchMock);

  const error = await invoke().catch((value: unknown) => value);

  expect(error).toBeInstanceOf(ModelGatewayInvocationError);
  expect(error).toMatchObject({
    kind: "network",
    message: cause.message,
    cause,
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

test.each([400, 429, 500, 503])(
  "HTTP %s failure preserves its established diagnostic",
  async (status) => {
    const fetchMock = vi.fn(async () => new Response("gateway failure", { status }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await invoke().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ModelGatewayInvocationError);
    expect(error).toMatchObject({
      kind: "http",
      message: `bridge_request_failed:${status}:gateway failure`,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test("a missing response body is a typed invocation failure", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null)));

  await expect(invoke()).rejects.toMatchObject({
    name: "ModelGatewayInvocationError",
    kind: "missing_stream",
    message: "no stream",
  });
});

test("an error frame rejects partial output without retry or acceptance", async () => {
  const partial = '{"decision":{"action":"invoke_capability"';
  const providerError = "ollama_stream_error: prediction aborted, token repeat limit reached";
  const fetchMock = vi.fn(async () => framesResponse([
    { type: "content", text: partial },
    { type: "error", error: providerError },
  ]));
  const acceptOutput = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const error = await invoke().then(acceptOutput).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(ModelGatewayInvocationError);
  expect(error).toMatchObject({
    kind: "stream",
    message: `model_stream_error: ${providerError}`,
  });
  expect(error).not.toHaveProperty("text");
  expect(String(error)).not.toContain(partial);
  expect(acceptOutput).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("a stream reader rejection preserves its cause", async () => {
  const cause = new TypeError("connection terminated while reading");
  const read = vi.fn().mockRejectedValue(cause);
  const reader = new InactivityBoundStreamReader(
    { read, cancel: vi.fn(async () => undefined) },
    new AbortController().signal,
    () => 1000,
  );

  await expect(reader.read()).rejects.toMatchObject({
    name: "ModelGatewayInvocationError",
    kind: "stream",
    message: cause.message,
    cause,
  });
  expect(read).toHaveBeenCalledOnce();
});

test("stream inactivity is distinct from request cancellation", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(async () => undefined);
  const reader = new InactivityBoundStreamReader(
    { read: () => new Promise(() => {}), cancel },
    new AbortController().signal,
    () => 20,
  );
  const outcome = reader.read().catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(20);

  expect(await outcome).toMatchObject({
    name: "ModelGatewayInvocationError",
    kind: "inactivity",
    message: "llm_stream_inactivity_timeout",
  });
  expect(cancel).toHaveBeenCalledWith("llm_stream_inactivity_timeout");
});

test("fetch cancellation retains the original abort error", async () => {
  const controller = new AbortController();
  const abort = new DOMException("User stopped the request.", "AbortError");
  vi.stubGlobal("fetch", vi.fn(async () => {
    controller.abort(abort);
    throw abort;
  }));

  await expect(invoke({ abortSignal: controller.signal })).rejects.toBe(abort);
});

test("cancellation during HTTP error-body reading takes precedence", async () => {
  const controller = new AbortController();
  const abort = new Error("request_cancelled");
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 500,
    async text() {
      controller.abort(abort);
      return "gateway failed";
    },
  })));

  await expect(invoke({ abortSignal: controller.signal })).rejects.toBe(abort);
});

test("stream cancellation wins over a competing reader rejection", async () => {
  const controller = new AbortController();
  const cancel = vi.fn(async () => undefined);
  const reader = new InactivityBoundStreamReader(
    {
      read: async () => {
        controller.abort(new Error("request_cancelled"));
        throw new Error("secondary socket failure");
      },
      cancel,
    },
    controller.signal,
    () => 1000,
  );
  const error = await reader.read().catch((value: unknown) => value);

  expect(error).toMatchObject({ name: "AbortError", message: "request_cancelled" });
  expect(error).not.toBeInstanceOf(ModelGatewayInvocationError);
  expect(cancel).toHaveBeenCalledOnce();
});

test.each(["onThinking", "onToken"] as const)(
  "%s callback failures remain programming failures",
  async (callback) => {
    const cause = new Error("callback invariant violated");
    vi.stubGlobal("fetch", vi.fn(async () => framesResponse([
      { type: callback === "onThinking" ? "thinking" : "content", text: "partial" },
    ])));

    await expect(invoke({ [callback]: () => { throw cause; } })).rejects.toBe(cause);
  },
);

test("request serialization failures stay outside transport classification", async () => {
  const format: Record<string, unknown> = {};
  format.self = format;
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const error = await invoke({ format }).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(TypeError);
  expect(error).not.toBeInstanceOf(ModelGatewayInvocationError);
  expect(fetchMock).not.toHaveBeenCalled();
});
