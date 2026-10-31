import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readModelGatewayUserMessage } from "../../client.js";
import { invokeModelGatewayWithOptions } from "../../client/chat.js";
import { invokeRawModelGatewayWithOptions } from "../../client/raw.js";
import { ModelGatewayInvocationError } from "../../client/invocation-error.js";
import { traceModelIo } from "../../observability/trace-store.js";
import { createChatHandler } from "../../server/chat-handler.js";
import { createRawHandler } from "../../server/raw-handler.js";
import type { GatewayResponse } from "../../server/contracts.js";
import type { ModelGatewayRequest } from "../../types.js";

vi.mock("../../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => true,
  traceModelIo: vi.fn(async () => {}),
}));

const MODEL = "qwen2.5:missing";
const POLICY = {
  providers: { local: {
    type: "ollama",
    baseUrl: "http://username:password@ollama.test:11434/private-path?key=SECRET_QUERY#SECRET_FRAGMENT",
  } },
  profiles: { fixture: { provider: "local", model: MODEL, contextWindowTokens: 32_768 } },
  defaults: { profileId: "fixture" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function captureResponse(): GatewayResponse & { body: string; headers: Record<string, string> } {
  return {
    body: "", headers: {}, statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; },
  };
}

async function invokeThroughGateway(endpoint: "chat" | "raw", fetchImpl: typeof fetch) {
  const handler = endpoint === "chat" ? createChatHandler({ fetchImpl }) : createRawHandler({ fetchImpl });
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const response = captureResponse();
    await handler(JSON.parse(String(init?.body)) as ModelGatewayRequest, response);
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  }));
  const common = { agentMode: "reasoning" as const, modelPolicy: POLICY, abortSignal: new AbortController().signal };
  const call = endpoint === "chat"
    ? invokeModelGatewayWithOptions({ ...common, text: "Check the model.", modelStep: "worker.evidence" }, { baseUrl: "http://gateway.test" })
    : invokeRawModelGatewayWithOptions({ ...common, prompt: "Write the result." }, { baseUrl: "http://gateway.test" });
  return call.catch((error: unknown) => error);
}

test.each(["chat", "raw"] as const)("%s explains a refused Ollama connection without changing error classification", async (endpoint) => {
  const cause = Object.assign(new Error("SECRET_PROVIDER_DETAIL"), { code: "ECONNREFUSED" });
  const failure = new TypeError("fetch failed", { cause });
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
  const error = await invokeThroughGateway(endpoint, fetchImpl);
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof ModelGatewayInvocationError).toBe(endpoint === "chat");
  expect((error as Error).message).toMatch(endpoint === "chat" ? /^bridge_request_failed:500:/u : /^bridge_raw_failed:500:/u);
  expect(readModelGatewayUserMessage(error)).toBe(
    "Can't reach Ollama at http://ollama.test:11434. Check that Ollama is running and that its address is correct.",
  );
  expect(console.error).toHaveBeenCalledWith(failure);
  expect(vi.mocked(traceModelIo).mock.calls.some(([entry]) => entry.event === "provider.failure")).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test.each(["chat", "raw"] as const)("%s explains an exact Ollama missing-model response and completes tracing", async (endpoint) => {
  const providerBody = JSON.stringify({ error: `model '${MODEL}' not found` });
  const error = await invokeThroughGateway(endpoint, async () => new Response(providerBody, { status: 404 }));
  const message = readModelGatewayUserMessage(error);
  expect(message).toBe(
    `Model "${MODEL}" isn't installed in Ollama at http://ollama.test:11434. Run \`ollama pull ${MODEL}\` on the machine running Ollama, then try again.`,
  );
  expect(message).not.toMatch(/username|password|SECRET|private-path/u);
  expect(JSON.stringify(vi.mocked(traceModelIo).mock.calls)).toContain(providerBody.replaceAll('"', '\\"'));
  expect(vi.mocked(traceModelIo).mock.calls.some(([entry]) => entry.event === "provider.response")).toBe(true);
});

test.each(["chat", "raw"] as const)("%s does not disclose or reinterpret an arbitrary 404 body", async (endpoint) => {
  const error = await invokeThroughGateway(endpoint, async () => new Response("SECRET_UPSTREAM_BODY", { status: 404 }));
  expect((error as Error).message).toContain("SECRET_UPSTREAM_BODY");
  expect(readModelGatewayUserMessage(error)).toBe(
    "The model service could not complete the request (HTTP 404). Check the model connection and configuration.",
  );
});

test("schema projection failure remains a local failure before provider fetch", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const handler = createChatHandler({ fetchImpl, modelPolicy: POLICY });
  const response = captureResponse();
  await handler({
    messages: [{ role: "user", content: "bounded" }],
    format: { type: "json_schema", name: "bad", schema: { type: "string", maxLength: 5 } },
  }, response);
  expect(response.statusCode).toBe(500);
  expect(response.body).toBe("server error");
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({
    message: "ollama_schema_constraint_not_post_validated:/maxLength",
  }));
});

test("known connection codes do not replace cancellation or publish a response", async () => {
  const controller = new AbortController();
  const cause = Object.assign(new Error("cancelled connection"), { code: "ECONNREFUSED" });
  const handler = createChatHandler({
    modelPolicy: POLICY,
    fetchImpl: async () => { controller.abort(cause); throw cause; },
  });
  const response = captureResponse();
  await handler({ messages: [{ role: "user", content: "request" }] }, response, { abortSignal: controller.signal });
  expect(response.body).toBe("");
  expect(console.error).not.toHaveBeenCalled();
});

test("a context admission failure never becomes an unreachable-provider explanation", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const handler = createChatHandler({ fetchImpl, modelPolicy: {
    ...POLICY, profiles: { fixture: { ...POLICY.profiles.fixture, contextWindowTokens: 1 } },
  } });
  const response = captureResponse();
  await handler({ messages: [{ role: "user", content: "request" }] }, response);
  expect(response.body).not.toContain("ollama_unreachable");
  expect(fetchImpl).not.toHaveBeenCalled();
});
