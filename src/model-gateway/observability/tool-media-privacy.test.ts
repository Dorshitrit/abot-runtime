import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../invocation-policy.js";
import { fetchProviderWithTrace } from "./provider-trace.js";
import { traceModelIo } from "./trace-store.js";
import { permitsModelContentTrace } from "./content-trace-policy.js";
import { toolMediaSafeError } from "./tool-media-privacy.js";
import { createOpenAIProviderAdapter } from "../providers/openai/adapter.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../types.js";
import {
  ModelProviderContextWindowExceededError,
  ModelProviderEnvelopeInspectionError,
} from "./context-window-guard.js";

vi.mock("./trace-store.js", () => ({ isModelIoTraceEnabled: () => true, traceModelIo: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

const evidence = { kind: "tool_image_v1", id: "private-image-ref" };
const requestBody = { modelStep: "execution.decision" as const, messages: [{ role: "tool", content: JSON.stringify({ result: { media: [evidence] } }), attachments: [{ data: "PRIVATE_PIXELS", toolEvidence: { executionId: "execution-1" } }] }] };
const invocation = resolveModelInvocation({ modelPolicy: {
  providers: { local: { type: "ollama" } }, profiles: { fixture: { provider: "local", model: "fixture", contextWindowTokens: 32768 } }, defaults: { profileId: "fixture" },
} });

test.each(["success", "failure"] as const)("%s keeps tool image bytes, reference metadata and provider echoes out of every content trace", async (outcome) => {
  const response = new Response("PRIVATE_PIXELS private-image-ref");
  const clone = vi.spyOn(response, "clone");
  const payload = { input: "PRIVATE_PIXELS private-image-ref" };
  const fetchImpl = vi.fn(async () => {
    if (outcome === "failure") throw new Error("PRIVATE_PIXELS private-image-ref");
    return response;
  });
  const run = fetchProviderWithTrace({ endpoint: "chat", requestBody, invocation, fetchImpl, url: "http://provider.test", headers: {}, payload, decodeResponse: async () => ({ text: "PRIVATE_PIXELS", thinking: "" }) });
  if (outcome === "failure") await expect(run).rejects.toThrow("tool_media_provider_error: content omitted");
  else await (await run).responseTrace;
  expect(fetchImpl).toHaveBeenCalledWith("http://provider.test", expect.objectContaining({ body: JSON.stringify(payload) }));
  expect(clone).not.toHaveBeenCalled();
  const trace = JSON.stringify(vi.mocked(traceModelIo).mock.calls);
  expect(trace).toContain("contentOmitted");
  expect(trace).not.toContain("PRIVATE_PIXELS");
  expect(trace).not.toContain("private-image-ref");
});

test("metadata remains private before hydration, inside raw author prompts and for text-only models", () => {
  const text = `Canonical passive evidence:\n${JSON.stringify({ media: [evidence] })}`;
  expect(permitsModelContentTrace("tool_payload.raw", text)).toBe(false);
  expect(permitsModelContentTrace("execution.decision", { messages: [{ content: JSON.stringify({ media: [evidence] }) }] })).toBe(false);
  expect(permitsModelContentTrace("execution.decision", { messages: [{ content: "ordinary text" }] })).toBe(true);
  const abort = new Error("private-image-ref");
  abort.name = "AbortError";
  expect(toolMediaSafeError(abort, text)).toMatchObject({ name: "AbortError", message: "tool_media_provider_error: content omitted" });
});

test.each([
  ModelProviderContextWindowExceededError,
  ModelProviderEnvelopeInspectionError,
])("preserves the safe %s contract without retaining private error fields", (ErrorType) => {
  const original = new ErrorType();
  original.message = "PRIVATE_PIXELS private-image-ref";
  original.cause = new Error("PRIVATE_PIXELS");
  const safe = toolMediaSafeError(original, requestBody);
  expect(safe).toBeInstanceOf(ErrorType);
  expect(safe).not.toBe(original);
  expect(safe).toMatchObject({ statusCode: 400, code: original.code, message: original.code });
  expect(safe).not.toHaveProperty("cause");
  expect(String(safe)).not.toContain("PRIVATE_PIXELS");
});

test("does not trust a provider error that copies safe error names or status fields", () => {
  const error = Object.assign(new Error("PRIVATE_PIXELS"), {
    name: "ModelProviderContextWindowExceededError",
    statusCode: 400,
    code: "model_context_window_exceeded",
  });
  expect(toolMediaSafeError(error, requestBody)).toEqual(new Error("tool_media_provider_error: content omitted"));
  expect(toolMediaSafeError(error, { messages: [{ role: "user", content: "ordinary text" }] })).toBe(error);
});

test("OpenAI stream error events redact image echoes before reaching Runtime error callbacks", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-only-injected-fetch");
  const body: ModelGatewayRequest = { modelStep: "worker.decision", messages: [{
    role: "user", content: JSON.stringify({ result: { media: [evidence] } }),
    attachments: [{ id: evidence.id, kind: "image", mimeType: "image/png", storageRef: "request-tool-media", data: "PRIVATE_PIXELS", toolEvidence: { executionId: "execution-1" } }],
  }], modelPolicy: {
    providers: { fixture: { type: "openai" } }, profiles: { fixture: { provider: "fixture", model: "fixture", contextWindowTokens: 32768 } }, defaults: { profileId: "fixture" },
  } };
  const result = await createOpenAIProviderAdapter().invoke({
    endpoint: "chat", requestBody: body, invocation: resolveModelInvocation(body),
    fetchImpl: async () => new Response(`data: ${JSON.stringify({ type: "error", error: { message: "PRIVATE_PIXELS private-image-ref" } })}\n\n`),
  });
  expect(result.kind).toBe("chat");
  if (result.kind !== "chat") throw new Error("expected fake chat stream");
  const events: ModelGatewayEvent[] = [];
  await result.stream({ emit: (event) => events.push(event) });
  expect(events).toEqual([{ type: "error", error: "tool_media_provider_error: content omitted" }]);
  expect(JSON.stringify(vi.mocked(traceModelIo).mock.calls)).not.toContain("PRIVATE_PIXELS");
});
