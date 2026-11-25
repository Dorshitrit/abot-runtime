import { afterEach, expect, test, vi } from "vitest";
import { invokeModelGatewayWithOptions } from "./chat.js";
import { invokeRawModelGatewayWithOptions } from "./raw.js";
import { respondToGatewayHandlerError } from "../server/errors.js";
import type { GatewayResponse } from "../server/contracts.js";
import {
  isProviderStreamDisconnectionError, PROVIDER_STREAM_DISCONNECTION,
  PROVIDER_STREAM_DISCONNECTION_HEADER, ProviderStreamDisconnectionError,
} from "../protocol/provider-stream-disconnection.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function invoke(endpoint: "chat" | "raw") {
  const common = { agentMode: "reasoning" as const, abortSignal: new AbortController().signal };
  const options = { baseUrl: "http://gateway.test" };
  return endpoint === "chat"
    ? invokeModelGatewayWithOptions({ ...common, text: "Fixture", modelStep: "execution.decision" }, options)
    : invokeRawModelGatewayWithOptions({ ...common, prompt: "Fixture" }, options);
}

function captureGatewayFailure(error: unknown): Response {
  const headers = new Headers();
  const chunks: string[] = [];
  const response: GatewayResponse = {
    statusCode: 200,
    setHeader(name, value) { headers.set(name, value); },
    write(chunk) { chunks.push(chunk); },
    end(chunk) { if (chunk) chunks.push(chunk); },
  };
  respondToGatewayHandlerError({
    error, response, abortSignal: new AbortController().signal, includeContextWindowErrors: true,
  });
  return new Response(chunks.join(""), { status: response.statusCode, headers });
}

test("an adapter-owned error frame reaches the chat caller with typed provenance and no client retry", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    type: "error", error: "openai function response not completed", providerDisconnection: PROVIDER_STREAM_DISCONNECTION,
  }) + "\n"));
  vi.stubGlobal("fetch", fetchMock);
  const error = await invoke("chat").catch((value: unknown) => value);
  expect(isProviderStreamDisconnectionError(error)).toBe(true);
  expect(error).toMatchObject({ kind: "stream", message: "model_stream_error: openai function response not completed" });
  expect(fetchMock).toHaveBeenCalledOnce();
});

test.each(["chat", "raw"] as const)("a typed server failure survives the %s HTTP boundary without client retry", async (endpoint) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const original = new Error("provider diagnostic", { cause: new ProviderStreamDisconnectionError() });
  const response = captureGatewayFailure(original);
  expect(response.headers.get(PROVIDER_STREAM_DISCONNECTION_HEADER)).toBe(PROVIDER_STREAM_DISCONNECTION);
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  const error = await invoke(endpoint).catch((value: unknown) => value);
  expect(isProviderStreamDisconnectionError(error)).toBe(true);
  expect(String(error)).toContain("500:server error");
  expect(fetchMock).toHaveBeenCalledOnce();
});

test.each([
  new Error("model_provider_stream_disconnected"),
  Object.assign(new Error("local gateway fault"), { code: "ECONNRESET" }),
  Object.assign(new Error("lookalike"), { name: "ProviderStreamDisconnectionError", code: "model_provider_stream_disconnected" }),
])("the server does not mark local or lookalike failures: %j", async (error) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = captureGatewayFailure(error);
  expect(response.headers.has(PROVIDER_STREAM_DISCONNECTION_HEADER)).toBe(false);
  expect(await response.text()).toBe("server error");
});

test.each([undefined, "provider_stream_disconnection_v2", { code: PROVIDER_STREAM_DISCONNECTION }])(
  "unknown error-frame markers remain ordinary stream failures: %j", async (providerDisconnection) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: "error", error: PROVIDER_STREAM_DISCONNECTION, providerDisconnection,
    }) + "\n"));
    vi.stubGlobal("fetch", fetchMock);
    const error = await invoke("chat").catch((value: unknown) => value);
    expect(isProviderStreamDisconnectionError(error)).toBe(false);
    expect(error).toMatchObject({ kind: "stream" });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

test.each(["fetch", "read"] as const)("a local gateway %s socket failure never becomes a provider disconnect", async (stage) => {
  const original = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
  const fetchMock = vi.fn(async () => {
    if (stage === "fetch") throw original;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const error = await invoke("chat").catch((value: unknown) => value);
  expect(isProviderStreamDisconnectionError(error)).toBe(false);
  expect(error).toMatchObject({ kind: stage === "fetch" ? "network" : "stream", cause: original });
  expect(fetchMock).toHaveBeenCalledOnce();
});
