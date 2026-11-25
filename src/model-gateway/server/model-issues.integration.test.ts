import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invokeModelGatewayWithOptions } from "../client/chat.js";
import { invokeRawModelGatewayWithOptions } from "../client/raw.js";
import { countModelGatewayInputTokensWithOptions } from "../client/input-token-count.js";
import { decodeModelIssues, encodeModelIssues, MODEL_ISSUE_HEADER, type ModelIssueDiagnostic } from "../protocol/model-issue.js";
import { readSourceIssueId } from "../../shared/source-issue.js";
import { createChatHandler } from "./chat-handler.js";
import { createRawHandler } from "./raw-handler.js";
import { createInputTokenCountHandler } from "./input-token-count-handler.js";
import type { GatewayResponse } from "./contracts.js";
import type { ModelGatewayRequest } from "../types.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
vi.mock("../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => false, traceModelIo: vi.fn(async () => {}),
}));
const policy = {
  providers: { fixture: { type: "openai", apiKeyEnv: "MODEL_ISSUE_TEST_KEY" } },
  profiles: { fixture: { provider: "fixture", model: "future-model", contextWindowTokens: 32768, supportsThinking: true } },
  defaults: { profileId: "fixture" },
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const rejected = () => Response.json({ error: {
  type: "invalid_request_error", code: "unsupported_value", param: "reasoning.effort",
  message: "PRIVATE upstream detail", extra: "PRIVATE data",
} }, { status: 400 });
const completed = () => new Response(frame({ type: "response.output_text.delta", delta: "answer" })
  + frame({ type: "response.completed", response: { status: "completed" } }));

beforeEach(() => vi.stubEnv("MODEL_ISSUE_TEST_KEY", "fixture-only"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function wire(endpoint: "chat" | "raw" | "input_tokens", providerFetch: typeof fetch, providerId = "fixture") {
  const modelPolicy = { ...policy, providers: { [providerId]: policy.providers.fixture },
    profiles: { fixture: { ...policy.profiles.fixture, provider: providerId } } };
  const options = { modelPolicy, fetchImpl: providerFetch };
  const handler = endpoint === "chat" ? createChatHandler(options)
    : endpoint === "raw" ? createRawHandler(options) : createInputTokenCountHandler(options);
  const responses: { headers: Headers; body: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const headers = new Headers();
    let body = "";
    const response: GatewayResponse = {
      statusCode: 200, setHeader: (name, value) => { headers.set(name, String(value)); },
      write: (chunk) => { body += chunk; }, end: (chunk = "") => { body += chunk; },
    };
    await handler(JSON.parse(String(init.body)) as ModelGatewayRequest, response);
    responses.push({ headers, body });
    return new Response(body, { status: response.statusCode, headers });
  }));
  return responses;
}

function params(onIssue = vi.fn()) {
  return { agentMode: "fast" as const, modelStep: "supervisor.response" as const,
    abortSignal: new AbortController().signal, messages: [{ role: "user", content: "PRIVATE prompt" }], onIssue };
}

test.each(["OpenAI Primary", "ספק ראשי"])("chat preserves configured provider %s across header, completed stream and client", async (providerId) => {
  const providerFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(completed());
  const responses = wire("chat", providerFetch, providerId);
  const input = params();
  const result = await invokeModelGatewayWithOptions(input);
  expect(result.text).toBe("answer");
  expect(providerFetch).toHaveBeenCalledTimes(2);
  expect(input.onIssue).toHaveBeenCalledOnce();
  const observed = input.onIssue.mock.calls[0]![0];
  expect(observed).toMatchObject({ providerId, outcome: "recovered", code: "model_reasoning_rejected",
    parameter: "reasoning_effort", requestedValue: "none", recovery: "provider_default", operation: "chat" });
  const pending = decodeModelIssues(responses[0]!.headers.get(MODEL_ISSUE_HEADER))[0]!;
  expect(pending.providerId).toBe(providerId);
  expect(pending.outcome).toBe("pending");
  expect(observed.issueId).toBe(pending.issueId);
  expect(observed.occurredAt).toBe(pending.occurredAt);
  const diagnosticFrame = responses[0]!.body.trim().split("\n").map((line) => JSON.parse(line))
    .find((value) => value.type === "diagnostic");
  expect(diagnosticFrame.diagnostic).toEqual(observed);
  expect(JSON.stringify(observed)).not.toContain("PRIVATE");
  expect(result.meta.unknownTypeCounts).toEqual({});
});

test.each(["http", "stream", "truncated"])("retry ending in %s produces one failed occurrence with exact cause", async (ending) => {
  const retried = ending === "http" ? rejected() : new Response(ending === "stream"
    ? frame({ type: "response.failed", response: { error: { message: "failed" } } })
    : frame({ type: "response.output_text.delta", delta: "partial" }));
  const providerFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(retried);
  wire("chat", providerFetch);
  const input = params();
  const error = await invokeModelGatewayWithOptions(input).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect(input.onIssue).toHaveBeenCalledOnce();
  expect(input.onIssue.mock.calls[0]![0].outcome).toBe("failed");
  expect(readSourceIssueId(error)).toBe(input.onIssue.mock.calls[0]![0].issueId);
  expect(readSourceIssueId(new Error("later unrelated failure"))).toBeUndefined();
  expect(providerFetch).toHaveBeenCalledTimes(2);
});

test("retry transport exception crosses the HTTP error path with one failed occurrence", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const providerFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected())
    .mockRejectedValueOnce(new Error("PRIVATE transport detail"));
  wire("chat", providerFetch);
  const input = params();
  const error = await invokeModelGatewayWithOptions(input).catch((value: unknown) => value);
  expect(input.onIssue).toHaveBeenCalledOnce();
  expect(input.onIssue.mock.calls[0]![0].outcome).toBe("failed");
  expect(readSourceIssueId(error)).toBe(input.onIssue.mock.calls[0]![0].issueId);
  expect(JSON.stringify(input.onIssue.mock.calls)).not.toContain("PRIVATE");
  expect(providerFetch).toHaveBeenCalledTimes(2);
});

test.each(["raw", "input_tokens"] as const)("%s success and cache use preserve one occurrence", async (endpoint) => {
  const providerFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected())
    .mockResolvedValueOnce(endpoint === "raw" ? completed() : Response.json({ input_tokens: 7 }));
  const providerId = "OpenAI ראשי";
  const responses = wire(endpoint, providerFetch, providerId);
  const input = params();
  if (endpoint === "raw") {
    expect((await invokeRawModelGatewayWithOptions({ ...input, prompt: "PRIVATE prompt" })).text).toBe("answer");
  } else {
    const cache = new Map();
    const count = { ...input, provider: "openai" };
    await countModelGatewayInputTokensWithOptions(count, {}, cache);
    await countModelGatewayInputTokensWithOptions(count, {}, cache);
  }
  expect(input.onIssue).toHaveBeenCalledOnce();
  expect(input.onIssue.mock.calls[0]![0]).toMatchObject({ providerId, outcome: "recovered", operation: endpoint });
  expect(decodeModelIssues(responses[0]!.headers.get(MODEL_ISSUE_HEADER))[0]!.providerId).toBe(providerId);
  expect(providerFetch).toHaveBeenCalledTimes(2);
});

test("invalid successful token-count body reports failed rather than recovered", async () => {
  wire("input_tokens", vi.fn<typeof fetch>().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(Response.json({ input_tokens: "7" })));
  const input = params();
  const error = await countModelGatewayInputTokensWithOptions({ ...input, provider: "openai" }).catch((value: unknown) => value);
  expect(input.onIssue).toHaveBeenCalledOnce();
  expect(input.onIssue.mock.calls[0]![0].outcome).toBe("failed");
  expect(readSourceIssueId(error)).toBe(input.onIssue.mock.calls[0]![0].issueId);
});

const pending: ModelIssueDiagnostic = { issueId: "fixture-issue", occurredAt: 123,
  code: "model_reasoning_rejected", outcome: "pending", profileId: "fixture",
  provider: "openai", model: "future-model", operation: "chat" };

test("HTTP200 and partial stream followed by cancellation remain interrupted", async () => {
  const abort = new AbortController();
  const input = { ...params(), abortSignal: abort.signal };
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"type":"content","text":"partial"}\n'));
  } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: {
    [MODEL_ISSUE_HEADER]: encodeModelIssues([pending])!,
  } })));
  const result = invokeModelGatewayWithOptions({ ...input, onToken: () => abort.abort(new Error("cancelled")) });
  await expect(result).rejects.toThrow("cancelled");
  expect(input.onIssue).toHaveBeenCalledExactlyOnceWith({ ...pending, outcome: "interrupted" });
});

test("an unrelated consumer callback failure cannot acquire the provider cause", async () => {
  const failure = new Error("local callback failed");
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"type":"content","text":"partial"}\n', { headers: {
    [MODEL_ISSUE_HEADER]: encodeModelIssues([pending])!,
  } })));
  await expect(invokeModelGatewayWithOptions({ ...params(), onToken: () => { throw failure; } })).rejects.toBe(failure);
  expect(readSourceIssueId(failure)).toBeUndefined();
});

test("ordinary successful requests do not emit issues or add retries", async () => {
  const providerFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(completed());
  wire("chat", providerFetch);
  const input = params();
  await invokeModelGatewayWithOptions(input);
  expect(input.onIssue).not.toHaveBeenCalled();
  expect(providerFetch).toHaveBeenCalledOnce();
});

test("actual runtime model step receives the diagnostic through the production client port", async () => {
  const { createModelGatewayClient } = await import("../client.js");
  const { invokeModelStep } = await import("../../runtime/model/invoke-step.js");
  const { createInvalidOutputRequest } = await import("../../runtime/__tests__/support/invalid-output-request.js");
  const { deriveTestRequestExecutionScope } = await import("../../runtime/__tests__/support/request-execution-scope.js");
  wire("chat", vi.fn<typeof fetch>().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(completed()));
  const client = createModelGatewayClient({ inputTokenCountProviders: [] });
  const onEvent = vi.fn();
  const request = deriveTestRequestExecutionScope(createInvalidOutputRequest(client.invoke), {
    modelPolicy: policy, modelGatewayClient: client, agentMode: "fast", onEvent,
  });
  const output = await invokeModelStep({ request, modelStep: "supervisor.response",
    messages: [{ role: "user", content: "PRIVATE input" }], timeoutReason: "fixture_timeout", accept: (text) => text });
  expect(output).toBe("answer");
  const events = onEvent.mock.calls.filter(([name]) => name === "model.issue.observed");
  expect(events).toHaveLength(1);
  expect(events[0]![1]).toMatchObject({ requestId: request.requestId,
    invocationId: expect.any(String), modelStep: "supervisor.response", outcome: "recovered" });
  expect(events[0]![1].invocationId.length).toBeGreaterThan(0);
});

test("runtime input-token count attaches its own invocation identity and emits once", async () => {
  const { createModelGatewayClient } = await import("../client.js");
  const { countModelInputTokens } = await import("../../runtime/model/input-token-count.js");
  const { resolveModelInvocation } = await import("../policy/invocation-policy.js");
  const { createInvalidOutputRequest } = await import("../../runtime/__tests__/support/invalid-output-request.js");
  const { deriveTestRequestExecutionScope } = await import("../../runtime/__tests__/support/request-execution-scope.js");
  wire("input_tokens", vi.fn<typeof fetch>().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(Response.json({ input_tokens: 7 })));
  const client = createModelGatewayClient();
  const onEvent = vi.fn();
  const request = deriveTestRequestExecutionScope(createInvalidOutputRequest(client.invoke), {
    modelPolicy: policy, modelGatewayClient: client, agentMode: "fast", onEvent,
  });
  const input = { request, invocation: resolveModelInvocation({ agentMode: "fast", modelPolicy: policy }),
    modelStep: "supervisor.response" as const, messages: [{ role: "user" as const, content: "PRIVATE input" }], onEvent };
  expect(await countModelInputTokens(input)).toBe(7);
  expect(await countModelInputTokens(input)).toBe(7);
  expect(onEvent).toHaveBeenCalledExactlyOnceWith("model.issue.observed", expect.objectContaining({
    requestId: request.requestId, invocationId: expect.any(String), modelStep: "supervisor.response",
    operation: "input_tokens", outcome: "recovered",
  }));
});
