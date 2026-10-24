import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { createModelProviderAdapterRegistry } from "../providers/contracts.js";
import type { ModelProviderAdapter } from "../providers/contracts.js";
import type { ModelGatewayRequest } from "../types.js";
import type { GatewayResponse } from "./contracts.js";
import type { InputTokenMeasurementStore } from "./input-token-measurements.js";
import { createInputTokenCountHandler } from "./input-token-count-handler.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
const SECRET = "private prompt and provider error sk-secret";
const request: ModelGatewayRequest = {
  debugRequestId: "request-count-test", modelStep: "capability.controls",
  messages: [
    { role: "user", content: SECRET },
    { role: "assistant", content: "", toolCalls: [{ callId: "call-1", name: "read", arguments: JSON.stringify({ value: SECRET }) }] },
    { role: "tool", content: SECRET, toolCallId: "call-1", toolName: "read" },
  ],
  format: { type: "json_schema", name: "fixture", schema: { type: "object", description: SECRET } },
};
const counted = { kind: "counted" as const, inputTokens: 42, providerEnvelopeFingerprint: "fixture" };

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function fixture(
  countInputTokens: NonNullable<ModelProviderAdapter["countInputTokens"]>,
  fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok")),
  measurements?: InputTokenMeasurementStore,
) {
  const handler = createInputTokenCountHandler({
    fetchImpl,
    modelPolicy: {
      providers: { fixture: { type: "count-fixture" } },
      profiles: { fixture: { provider: "fixture", model: "fixture-model", contextWindowTokens: 32000 } },
      defaults: { profileId: "fixture" },
    },
    providerAdapters: createModelProviderAdapterRegistry([{
      type: "count-fixture", supportsImageInput: false, countInputTokens,
      invoke: vi.fn(),
    }]),
  }, measurements);
  const response: GatewayResponse & { body: string } = {
    body: "", setHeader: vi.fn(),
    write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; },
  };
  return { handler, response, fetchImpl };
}

function failure() {
  const calls = vi.mocked(traceDebug).mock.calls.filter(
    ([scope, event]) => scope === "model-gateway.server" && event === "input_tokens.request.failed",
  );
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls)).not.toContain(SECRET);
  return calls[0]![2]!;
}

test("captures nested connect timeouts without claiming an upstream HTTP 500", async () => {
  const inner = Object.assign(new Error(SECRET), { code: "ETIMEDOUT", errno: -110 });
  const aggregate = Object.assign(new AggregateError([inner], SECRET), { code: "ETIMEDOUT" });
  const error = new TypeError(SECRET, { cause: aggregate });
  const f = fixture(async ({ fetchImpl }) => {
    await fetchImpl("https://provider.test/input_tokens", { method: "POST", body: SECRET });
    return counted;
  }, vi.fn<typeof fetch>().mockRejectedValue(error));
  await f.handler(request, f.response);
  expect(f.response.statusCode).toBe(500);
  expect(f.response.body).toBe("server error");
  expect(console.error).toHaveBeenCalledWith(error);
  expect(failure()).toMatchObject({
    requestId: "request-count-test", modelStep: "capability.controls",
    provider: "count-fixture", profileId: "fixture", model: "fixture-model",
    phase: "provider_count", failureKind: "exception", aborted: false,
    requestShape: { messageCount: 3, contentChars: SECRET.length * 2, toolCallCount: 1, toolResultCount: 1 },
    upstream: { attempted: true, responseReceived: false, requestBytes: Buffer.byteLength(SECRET),
      errors: [{ type: "TypeError", relation: "error" },
        { type: "AggregateError", relation: "cause", code: "ETIMEDOUT", aggregateErrorCount: 1 },
        { type: "Error", relation: "aggregate", code: "ETIMEDOUT", errno: -110 }] },
  });
  expect(failure().upstream).not.toHaveProperty("statusCode");
});

test("distinguishes an upstream HTTP500 and retains its safe request ID without reading its body", async () => {
  const upstream = new Response(SECRET, { status: 500, headers: {
    "x-request-id": "req_provider-123", Authorization: SECRET, "set-cookie": SECRET,
  } });
  const f = fixture(async ({ fetchImpl }) => {
    const response = await fetchImpl("https://provider.test/input_tokens", { body: SECRET });
    expect(response.bodyUsed).toBe(false);
    return { kind: "error", statusCode: response.status, message: "original provider failure" };
  }, vi.fn<typeof fetch>().mockResolvedValue(upstream));
  await f.handler(request, f.response);
  expect(f.response.statusCode).toBe(500);
  expect(f.response.body).toBe("original provider failure");
  expect(failure()).toMatchObject({
    failureKind: "provider_result", statusCode: 500,
    upstream: { responseReceived: true, statusCode: 500, requestId: "req_provider-123" },
  });
});

test("records a local provider exception before fetch without invented upstream metadata", async () => {
  const error = new SyntaxError(SECRET);
  const f = fixture(async () => { throw error; });
  await f.handler(request, f.response);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(f.response.body).toBe("server error");
  expect(failure()).toMatchObject({ phase: "provider_count", upstream: {}, errors: [{ type: "SyntaxError" }] });
});

test("records a local measurement failure after a successful fetch separately", async () => {
  const error = new RangeError(SECRET);
  const measurements: InputTokenMeasurementStore = {
    resolve: vi.fn(), record: vi.fn(() => { throw error; }),
  };
  const f = fixture(async ({ fetchImpl }) => {
    await fetchImpl("https://provider.test/input_tokens");
    return counted;
  }, undefined, measurements);
  await f.handler(request, f.response);
  expect(f.response.body).toBe("server error");
  expect(failure()).toMatchObject({
    phase: "measurement_record", failureKind: "exception",
    upstream: { responseReceived: true, statusCode: 200 }, errors: [{ type: "RangeError" }],
  });
});

test("keeps abort response silent and preserves the original abort error", async () => {
  const controller = new AbortController();
  const error = new Error(SECRET);
  const f = fixture(async ({ fetchImpl }) => {
    await fetchImpl("https://provider.test/input_tokens");
    return counted;
  }, vi.fn<typeof fetch>(async () => { controller.abort(error); throw error; }));
  await f.handler(request, f.response, { abortSignal: controller.signal });
  expect(f.response.body).toBe("");
  expect(f.response.statusCode).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
  expect(failure()).toMatchObject({ aborted: true, upstream: { responseReceived: false } });
});

test("success retains the existing count response and emits no extra diagnostic event", async () => {
  const f = fixture(async ({ fetchImpl }) => {
    await fetchImpl("https://provider.test/input_tokens");
    return counted;
  });
  await f.handler(request, f.response);
  expect(f.response.statusCode).toBe(200);
  expect(JSON.parse(f.response.body)).toMatchObject({ inputTokens: 42, model: "fixture-model" });
  expect(vi.mocked(traceDebug).mock.calls.map(([, event]) => event)).toEqual(["model.input_tokens.counted"]);
});

test("unsafe header IDs and arbitrary error properties never enter diagnostics", async () => {
  const f = fixture(async ({ fetchImpl }) => {
    await fetchImpl("https://provider.test/input_tokens");
    throw Object.assign(new Error(SECRET), { code: SECRET, headers: { Authorization: SECRET }, body: SECRET });
  }, vi.fn<typeof fetch>().mockResolvedValue(new Response(SECRET, {
    status: 200, headers: { "x-request-id": SECRET },
  })));
  await f.handler(request, f.response);
  expect(failure().upstream).not.toHaveProperty("requestId", SECRET);
  expect(failure().errors).toEqual([{ relation: "error", type: "Error" }]);
});

test("throwing diagnostic sinks cannot replace the terminal response", async () => {
  vi.mocked(traceDebug).mockImplementation(() => { throw new Error("diagnostic sink failed"); });
  const f = fixture(async () => { throw new TypeError(SECRET); });
  await f.handler(request, f.response);
  expect(f.response.statusCode).toBe(500);
  expect(f.response.body).toBe("server error");
});
