import { afterEach, expect, test, vi } from "vitest";
import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { createModelGatewayClient } from "../client.js";
import { countModelGatewayInputTokensWithOptions } from "./input-token-count.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
const SECRET = "private prompt and provider response sk-secret";
const options = { baseUrl: "http://gateway.test" };
function params(signal = new AbortController().signal) {
  return {
    provider: "openai", messages: [{ role: "user", content: SECRET }],
    format: { type: "json_schema", name: "secret_schema", schema: { description: SECRET } },
    agentMode: "fast" as const, modelStep: "capability.controls" as const,
    debugRequestId: "count-client-request", abortSignal: signal,
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function failure() {
  const failures = vi.mocked(traceDebug).mock.calls.filter(([, event]) => event === "input_tokens.request.failed");
  expect(failures).toHaveLength(1);
  expect(JSON.stringify(failures)).not.toContain(SECRET);
  return failures[0]![2]!;
}

test("client HTTP500 diagnostic leaves exact existing bridge failure text intact", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("server error", { status: 500 }));
  vi.stubGlobal("fetch", fetchImpl);
  await expect(countModelGatewayInputTokensWithOptions(params(), options)).rejects.toThrow(
    "bridge_input_token_count_failed:500:server error",
  );
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(failure()).toMatchObject({
    requestId: "count-client-request", modelStep: "capability.controls", provider: "openai",
    phase: "bridge_response", statusCode: 500, failureKind: "exception",
    requestShape: { messageCount: 1, contentChars: SECRET.length },
  });
});

test("network failure retains exact exception identity and safe nested code", async () => {
  const error = new TypeError(SECRET, { cause: Object.assign(new Error(SECRET), { code: "ECONNRESET" }) });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(error));
  await expect(countModelGatewayInputTokensWithOptions(params(), options)).rejects.toBe(error);
  expect(failure()).toMatchObject({
    phase: "bridge_fetch", errors: [
      { type: "TypeError", relation: "error" },
      { type: "Error", relation: "cause", code: "ECONNRESET" },
    ],
  });
});

test("invalid success response retains parser failure with bridge status", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ inputTokens: SECRET })));
  await expect(countModelGatewayInputTokensWithOptions(params(), options)).rejects.toThrow(
    "model_gateway_input_token_count_response_invalid",
  );
  expect(failure()).toMatchObject({ phase: "bridge_parse", statusCode: 200 });
});

test("aborted count preserves original abort identity without retry", async () => {
  const controller = new AbortController();
  const error = new Error(SECRET);
  const fetchImpl = vi.fn<typeof fetch>(async () => { controller.abort(error); throw error; });
  vi.stubGlobal("fetch", fetchImpl);
  await expect(countModelGatewayInputTokensWithOptions(params(controller.signal), options)).rejects.toBe(error);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(failure()).toMatchObject({ aborted: true, phase: "bridge_fetch" });
});

test("successful cached counts preserve identity and existing logging frequency", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    inputTokens: 42, provider: "openai", profileId: "test", model: "fixture",
    contextWindowTokens: 32000, source: "provider_input_token_count",
  }));
  vi.stubGlobal("fetch", fetchImpl);
  const client = createModelGatewayClient(options);
  const input = params();
  const first = await client.countInputTokens(input);
  expect(await client.countInputTokens(input)).toBe(first);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(vi.mocked(traceDebug).mock.calls.map(([, event]) => event)).toEqual([
    "input_tokens.request.start", "input_tokens.request.completed",
  ]);
});
