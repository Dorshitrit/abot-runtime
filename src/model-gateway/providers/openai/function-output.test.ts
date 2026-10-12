import { afterEach, expect, test, vi } from "vitest";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "./payload.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { countOpenAIInputTokens } from "./input-token-count.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { resolveOpenAIFunctionOutputName } from "./function-output.js";
import { controlsFormat, nativeRequest } from "./__tests__/native-function-fixture.js";

afterEach(() => vi.unstubAllEnvs());

test.each([["fast", "none"], ["reasoning", "medium"], ["deep", "high"]] as const)(
  "projects the unchanged controls envelope as one function in %s", (agentMode, effort) => {
    const body = buildOpenAIResponsesPayload({ ...nativeRequest, agentMode });
    expect(body).toMatchObject({
      input: nativeRequest.messages, reasoning: { effort },
      tools: [{ type: "function", name: controlsFormat.name, strict: true, parameters: controlsFormat.schema }],
      tool_choice: { type: "function", name: controlsFormat.name }, parallel_tool_calls: false,
    });
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(resolveOpenAIFunctionOutputName(body)).toBe(controlsFormat.name);
  },
);

test.each(["execution.decision", "worker.decision", "planner.graph", "execution.response", "tool_payload.raw"])(
  "retains text formatting for %s even with the same schema name", (modelStep) => {
    const body = buildOpenAIResponsesPayload({ ...nativeRequest, modelStep });
    expect(body.text).toEqual({ format: controlsFormat });
    expect(body).not.toHaveProperty("tools");
    expect(resolveOpenAIFunctionOutputName(body)).toBeUndefined();
  },
);

test.each(["json", { type: "text" }, { type: "json_object" }])(
  "keeps existing non-schema gateway requests valid: %j", (format) => {
    const body = buildOpenAIResponsesPayload({ ...nativeRequest, format });
    expect(body).not.toHaveProperty("tools");
  },
);

test("carries provider schema constraints and strips internal projection metadata", () => {
  const format = {
    ...controlsFormat, description: "Prepared controls", strict: false,
    postValidatedSchemaConstraints: [{ keyword: "maxLength", path: "/properties/decision/properties/path/maxLength" }],
  };
  const body = buildOpenAIResponsesPayload({ ...nativeRequest, format });
  expect(body.tools).toEqual([{
    type: "function", name: format.name, description: format.description,
    strict: false, parameters: format.schema,
  }]);
  expect(JSON.stringify(body)).not.toContain("postValidatedSchema");
});

test("keeps native tool history linked and never rewrites prior execution arguments", () => {
  const messages = [
    { role: "assistant", content: "", toolCalls: [{ callId: "execution_1", name: "read_file", arguments: '{"path":"a"}' }] },
    { role: "tool", content: "observed data", toolCallId: "execution_1", toolName: "read_file" },
  ] as const;
  expect(buildOpenAIResponsesPayload({ ...nativeRequest, messages }).input).toEqual([
    { type: "function_call", call_id: "execution_1", name: "read_file", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "execution_1", output: "observed data" },
  ]);
});

test("counts the same function declaration and forced choice that are sent to generation", async () => {
  vi.stubEnv("NATIVE_TEST_KEY", "fixture-only");
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ input_tokens: 321 }));
  const result = await countOpenAIInputTokens({
    endpoint: "raw", requestBody: nativeRequest, invocation: resolveModelInvocation(nativeRequest), fetchImpl,
  });
  const generation = buildOpenAIResponsesPayload(nativeRequest);
  const { stream: _stream, temperature: _temperature, top_p: _topP, ...expected } = generation;
  expect(buildOpenAIInputTokenCountPayload(nativeRequest)).toEqual(expected);
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(expected);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://native.test/v1/responses/input_tokens");
  expect(result).toMatchObject({ kind: "counted", inputTokens: 321, providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(generation) });
});
