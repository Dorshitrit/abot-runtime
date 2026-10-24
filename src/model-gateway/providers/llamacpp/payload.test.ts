import { describe, expect, test } from "vitest";
import { createProviderEnvelopeFingerprint, estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../../types.js";
import { buildLlamaCppChatPayload } from "./payload.js";
import { projectLlamaCppFormat } from "./schema-format.js";

function invocation(overrides: Partial<ResolvedModelInvocation> = {}): ResolvedModelInvocation {
  return {
    model: "gemma-test",
    profile: {
      id: "gemma", label: "Gemma", providerId: "local", provider: "llamacpp",
      model: "gemma-test", contextWindowTokens: 32768, supportsThinking: true,
      capabilities: { inputModalities: ["text"], outputModalities: ["text"] },
      generation: { temperature: 0.6, topP: 0.9 }, options: {}, context: {},
    },
    ...overrides,
  };
}
function payload(resolved = invocation(), requestBody: ModelGatewayRequest = { text: "hello" }) {
  return buildLlamaCppChatPayload({ endpoint: "chat", requestBody, invocation: resolved });
}

describe("llama.cpp payload", () => {
  test("separates thinking and requests usage without inventing an output cap", () => {
    expect(payload()).toEqual({
      model: "gemma-test", messages: [{ role: "user", content: "hello" }],
      stream: true, stream_options: { include_usage: true }, reasoning_format: "deepseek",
      temperature: 0.6, top_p: 0.9,
    });
  });
  test("explicit none remains disabled even with a contradictory budget", () => {
    expect(payload(invocation({ think: "none", reasoningBudget: { mode: "tokens", tokens: 10 } }))).toMatchObject({
      reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false },
      reasoning_budget_tokens: 0,
    });
  });
  test.each(["low", "medium", "high"] as const)("effort %s explicitly enables the template without inventing a budget", (think) => {
    const result = payload(invocation({ think }));
    expect(result).toMatchObject({ reasoning_effort: think, chat_template_kwargs: { enable_thinking: true } });
    expect(result).not.toHaveProperty("reasoning_budget_tokens");
  });
  test("finite resolved budget overrides the server template default", () => {
    expect(payload(invocation({ reasoningBudget: { mode: "tokens", tokens: 321 } }))).toMatchObject({
      reasoning_budget_tokens: 321, chat_template_kwargs: { enable_thinking: true },
    });
  });
  test("server-default passes the native sentinel without claiming unlimited", () => {
    expect(payload(invocation({ reasoningBudget: { mode: "server-default" } })))
      .toMatchObject({ reasoning_budget_tokens: -1, chat_template_kwargs: { enable_thinking: true } });
  });
  test.each([-1, 1.2, Number.POSITIVE_INFINITY, 2147483648])("rejects invalid finite budget %s", (tokens) => {
    expect(() => payload(invocation({ reasoningBudget: { mode: "tokens", tokens } }))).toThrow("llamacpp_reasoning_budget_invalid");
  });
  test("preserves tool identities, exact argument/result bytes, roles and order", () => {
    const messages = [
      { role: "system", content: "caller-owned" },
      { role: "user", content: "make a file" },
      { role: "assistant", content: "", toolCalls: [{ callId: "call-1", name: "write_file", arguments: '{ "path": "x", "content": "é" }' }] },
      { role: "tool", content: '{"ok":true}\n', toolCallId: "call-1", toolName: "write_file" },
    ];
    expect(payload(invocation({ instructions: [" stage-only ", ""] }), { messages }).messages).toEqual([
      { role: "system", content: "stage-only" },
      { role: "system", content: "caller-owned" },
      { role: "user", content: "make a file" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: {
        name: "write_file", arguments: '{ "path": "x", "content": "é" }',
      } }] },
      { role: "tool", content: '{"ok":true}\n', tool_call_id: "call-1", name: "write_file" },
    ]);
  });
  test("rejects malformed history and attachments before fetch", () => {
    expect(() => payload(invocation(), { messages: [{ role: "tool", content: "x", toolCallId: "x", toolName: "a" }] }))
      .toThrow("model_gateway_tool_result_unmatched");
    expect(() => payload(invocation(), { messages: [{ role: "user", content: "", attachments: [{}] }] }))
      .toThrow("llamacpp_image_input_unsupported");
  });
  test("raw prompt uses the same completion protocol", () => {
    expect(buildLlamaCppChatPayload({ endpoint: "raw", invocation: invocation(), requestBody: { prompt: "raw bytes\n" } }).messages)
      .toEqual([{ role: "user", content: "raw bytes\n" }]);
  });
  test("never forwards arbitrary provider options over canonical controls", () => {
    const resolved = invocation();
    resolved.profile.options = { model: "wrong", reasoning_budget_tokens: 9999, max_tokens: 2, stream: false };
    expect(payload(resolved)).not.toHaveProperty("max_tokens");
    expect(payload(resolved)).not.toHaveProperty("reasoning_budget_tokens");
    expect(payload(resolved).model).toBe("gemma-test");
  });
});

describe("llama.cpp grammar", () => {
  test("retains root unions and every schema constraint without prompt prose", () => {
    const schema = { oneOf: [{ type: "object", properties: { text: { type: "string", maxLength: 10 } }, required: ["text"], additionalProperties: false }, { type: "null" }] };
    const result = payload(invocation(), { text: "hello", format: {
      type: "json_schema", name: "decision", strict: true, schema,
      postValidatedSchemaConstraints: [{ keyword: "maxLength", path: "/oneOf/0/properties/text" }],
    } });
    expect(result.response_format).toEqual({ type: "json_schema", json_schema: { name: "decision", strict: true, schema } });
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(JSON.stringify(result)).not.toContain("postValidatedSchemaConstraints");
  });
  test("projects JSON, bare schemas and text explicitly", () => {
    expect(projectLlamaCppFormat("json")).toEqual({ type: "json_object" });
    expect(projectLlamaCppFormat({ type: "json_object" })).toEqual({ type: "json_object" });
    expect(projectLlamaCppFormat({ type: "text" })).toBeUndefined();
    expect(projectLlamaCppFormat({ type: "array", items: { type: "string" } }))
      .toEqual({ type: "json_schema", json_schema: { name: "runtime_output", schema: { type: "array", items: { type: "string" } } } });
  });
  test("rejects misplaced projection metadata and malformed wrappers", () => {
    expect(() => projectLlamaCppFormat({ type: "object", postValidatedSchemaConstraints: [] })).toThrow("projection metadata");
    expect(() => projectLlamaCppFormat({ type: "json_schema" })).toThrow("llamacpp_json_schema_wrapper_invalid");
  });
  test("binds grammar/template identity without charging grammar as prompt tokens", () => {
    const base = payload();
    const grammar = { ...base, response_format: { type: "json_object" } };
    const thinking = { ...base, chat_template_kwargs: { enable_thinking: true } };
    expect(estimateProviderEnvelopeInputTokens(grammar)).toBe(estimateProviderEnvelopeInputTokens(base));
    expect(createProviderEnvelopeFingerprint(grammar)).not.toBe(createProviderEnvelopeFingerprint(base));
    expect(createProviderEnvelopeFingerprint(thinking)).not.toBe(createProviderEnvelopeFingerprint(base));
    expect(createProviderEnvelopeFingerprint({ ...base, temperature: 1 })).toBe(createProviderEnvelopeFingerprint(base));
  });
});
