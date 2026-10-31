import { describe, expect, test } from "vitest";
import type { ChatMessage, ModelGatewayRequest } from "../../types.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "./payload.js";
import { buildChatGptResponsesPayload } from "../openai-chatgpt/payload.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";

const marker = { mode: "explicit" };
const optIn = { prompt_cache_options: { mode: "implicit" } };
const messages: ChatMessage[] = [
  { role: "system", content: "Stable instructions" },
  { role: "user", content: "Current request" },
  { role: "user", content: "Changing activation state" },
];
function request(overrides: Partial<ModelGatewayRequest> = {}, options: Record<string, unknown> = optIn): ModelGatewayRequest {
  return {
    messages, agentMode: "reasoning", modelStep: "execution.decision",
    promptCacheBoundaryBeforeMessageIndex: 2,
    modelPolicy: {
      providers: { remote: { type: "openai" } },
      profiles: { main: { provider: "remote", model: "arbitrary-supported-model", contextWindowTokens: 32000, options } },
      defaults: { profileId: "main" },
    },
    ...overrides,
  };
}

describe("OpenAI request-local stable prefix breakpoint", () => {
  test("marks the preceding user text without changing canonical messages", () => {
    const before = JSON.stringify(messages);
    const payload = buildOpenAIResponsesPayload(request());
    expect(payload.prompt_cache_options).toEqual({ mode: "implicit" });
    expect(payload.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "Stable instructions" }] },
      { role: "user", content: [{ type: "input_text", text: "Current request", prompt_cache_breakpoint: marker }] },
      { role: "user", content: [{ type: "input_text", text: "Changing activation state" }] },
    ]);
    expect(JSON.stringify(messages)).toBe(before);
  });
  test.each([undefined, -1, 0, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("omits invalid boundary %s", (index) => {
    const baseline = buildOpenAIResponsesPayload(request({ promptCacheBoundaryBeforeMessageIndex: undefined }));
    expect(buildOpenAIResponsesPayload(request({ promptCacheBoundaryBeforeMessageIndex: index }))).toEqual(baseline);
  });
  test.each([{}, { prompt_cache_options: { mode: "explicit" } }, { prompt_cache_options: { mode: "implicit", ttl: "12h" } }, { prompt_cache_options: true }])(
    "leaves unconfigured or unsupported options unchanged: %j", (options) => {
      const input = request({}, options);
      expect(buildOpenAIResponsesPayload(input)).toEqual(buildOpenAIResponsesPayload({ ...input, promptCacheBoundaryBeforeMessageIndex: undefined }));
    },
  );
  test("does not apply the hint to unrelated steps", () => {
    const input = request({ modelStep: "execution.response" });
    expect(buildOpenAIResponsesPayload(input)).toEqual(buildOpenAIResponsesPayload({ ...input, promptCacheBoundaryBeforeMessageIndex: undefined }));
  });
  test("marks a native tool output after call flattening and before prepended instructions", () => {
    const input = request({ messages: [
      messages[0]!,
      { role: "assistant", content: "", toolCalls: [
        { callId: "call-a", name: "tool_a", arguments: "{}" },
        { callId: "call-b", name: "tool_b", arguments: "{}" },
      ] },
      { role: "tool", content: "result a", toolCallId: "call-a", toolName: "tool_a" },
      { role: "tool", content: "result b", toolCallId: "call-b", toolName: "tool_b" },
      messages[2]!,
    ], promptCacheBoundaryBeforeMessageIndex: 4 });
    input.modelPolicy!.profiles!.main!.calibration = { decision: { instructions: ["Prepended calibration"] } };
    input.modelPolicy!.defaults!.steps = { "execution.decision": "decision" };
    const payload = buildOpenAIResponsesPayload(input);
    expect(payload.input).toEqual([
      { role: "system", content: "Prepended calibration" },
      { role: "system", content: [{ type: "input_text", text: "Stable instructions" }] },
      { type: "function_call", call_id: "call-a", name: "tool_a", arguments: "{}" },
      { type: "function_call", call_id: "call-b", name: "tool_b", arguments: "{}" },
      { type: "function_call_output", call_id: "call-a", output: [{ type: "input_text", text: "result a" }] },
      { type: "function_call_output", call_id: "call-b", output: [{ type: "input_text", text: "result b", prompt_cache_breakpoint: marker }] },
      { role: "user", content: [{ type: "input_text", text: "Changing activation state" }] },
    ]);
  });
  test.each(["user", "tool"] as const)("includes the final image in the %s boundary", (role) => {
    const stable = { role, content: "Image evidence", attachments: [{ id: "image", kind: "image" as const, mimeType: "image/png", storageRef: "test", size: 4, data: "YQ==", ...(role === "tool" ? { toolEvidence: { executionId: "call" } } : {}) }], ...(role === "tool" ? { toolCallId: "call", toolName: "read_image" } : {}) } as ChatMessage;
    const prefix: ChatMessage[] = role === "tool" ? [{ role: "assistant", content: "", toolCalls: [{ callId: "call", name: "read_image", arguments: "{}" }] }] : [];
    const input = request({ messages: [...prefix, stable, messages[2]!], promptCacheBoundaryBeforeMessageIndex: prefix.length + 1 });
    const output = buildOpenAIResponsesPayload(input).input as Record<string, unknown>[];
    const item = output[prefix.length]!;
    expect(item[role === "tool" ? "output" : "content"]).toEqual([
      { type: "input_text", text: "Image evidence" },
      { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "auto", prompt_cache_breakpoint: marker },
    ]);
  });
  test("omits the hint for an assistant text boundary", () => {
    const input = request({ messages: [{ role: "assistant", content: "Earlier reply" }, messages[2]!], promptCacheBoundaryBeforeMessageIndex: 1 });
    expect(buildOpenAIResponsesPayload(input)).toEqual(buildOpenAIResponsesPayload({ ...input, promptCacheBoundaryBeforeMessageIndex: undefined }));
  });
  test("omits a boundary inside a native call/result group without normalizing its content", () => {
    const input = request({ messages: [
      { role: "assistant", content: "", toolCalls: [{ callId: "call", name: "read", arguments: "{}" }] },
      { role: "tool", content: "result", toolCallId: "call", toolName: "read" },
      messages[2]!,
    ], promptCacheBoundaryBeforeMessageIndex: 1 });
    expect(buildOpenAIResponsesPayload(input)).toEqual(buildOpenAIResponsesPayload({ ...input, promptCacheBoundaryBeforeMessageIndex: undefined }));
  });
  test("counts identical marked input without unsupported cache controls and preserves measurement binding", () => {
    const generated = buildOpenAIResponsesPayload(request());
    const { stream: _stream, prompt_cache_options: _cacheOptions, ...expected } = generated;
    const counted = buildOpenAIInputTokenCountPayload(request());
    expect(counted).toEqual(expected);
    expect(counted).not.toHaveProperty("prompt_cache_options");
    expect(createProviderEnvelopeFingerprint(counted)).toBe(createProviderEnvelopeFingerprint(generated));
  });
  test("keeps earlier endpoints identical while the boundary advances across tool activations", () => {
    const stripMarkers = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "prompt_cache_breakpoint" ? undefined : item));
    const stable: ChatMessage[] = [messages[0]!, messages[1]!];
    const payloads: unknown[][] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      if (turn > 0) stable.push(
        { role: "assistant", content: "", toolCalls: [{ callId: `call-${turn}`, name: "read", arguments: "{}" }] },
        { role: "tool", content: `Result ${turn}`, toolCallId: `call-${turn}`, toolName: "read" },
      );
      const input = request({ messages: [...stable, { role: "user", content: `Activation ${turn}` }], promptCacheBoundaryBeforeMessageIndex: stable.length });
      const payload = buildOpenAIResponsesPayload(input);
      const { stream: _stream, prompt_cache_options: _cacheOptions, ...countPayload } = payload;
      expect(buildOpenAIInputTokenCountPayload(input)).toEqual(countPayload);
      payloads.push(payload.input as unknown[]);
    }
    for (let turn = 1; turn < payloads.length; turn += 1) {
      const previousPrefix = payloads[turn - 1]!.slice(0, -1);
      expect(stripMarkers(payloads[turn]!.slice(0, previousPrefix.length))).toEqual(stripMarkers(previousPrefix));
    }
  });
  test("never projects cache metadata through the shared ChatGPT payload builder", () => {
    const input = request();
    input.modelPolicy!.providers!.remote!.type = "openai-chatgpt";
    expect(buildChatGptResponsesPayload(input)).toEqual(buildChatGptResponsesPayload({ ...input, promptCacheBoundaryBeforeMessageIndex: undefined }));
    expect(JSON.stringify(buildChatGptResponsesPayload(input))).not.toContain("prompt_cache");
  });
});
