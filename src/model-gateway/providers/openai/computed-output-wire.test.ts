import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayEvent, ModelGatewayRequest, ModelGenerationConfig } from "../../types.js";
import type { ModelProviderInputTokenMeasurement } from "../contracts.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { buildOpenAIInputTokenCountPayload } from "./payload.js";
import { completedFunction, controlsFormat, frame, functionArguments } from "./__tests__/native-function-fixture.js";

type OutputMode = "native" | "json" | "plain";
const answer = '{"answer":"complete"}';
const answerFormat = { type: "json_schema", name: "answer", strict: true,
  schema: { type: "object", properties: { answer: { type: "string" } },
    required: ["answer"], additionalProperties: false } };

const outputContracts: Record<OutputMode, Pick<ModelGatewayRequest, "modelStep" | "format">> = {
  native: { modelStep: "capability.controls", format: controlsFormat },
  json: { modelStep: "supervisor.decision", format: answerFormat },
  plain: { modelStep: "execution.file_payload.raw" },
};

function request(mode: OutputMode = "native", generation?: ModelGenerationConfig): ModelGatewayRequest {
  return {
    messages: [{ role: "user", content: "Finish the selected operation." }],
    ...outputContracts[mode],
    modelPolicy: {
      outputSafetyReserveTokens: 1200,
      providers: { api: { type: "openai", baseUrl: "https://computed-output.test/v1", apiKeyEnv: "COMPUTED_OUTPUT_TEST_KEY" } },
      profiles: { luna: { provider: "api", model: "gpt-6-luna", contextWindowTokens: 32000,
        ...(generation ? { generation } : {}) } },
      defaults: { profileId: "luna" },
    },
  };
}

function response(mode: OutputMode): Response {
  const item = { type: "message", id: "answer", phase: "final_answer",
    content: [{ type: "output_text", text: answer }] };
  const events = mode === "native" ? [completedFunction] : [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, delta: answer },
    { type: "response.completed", response: { status: "completed", output: [item] } },
  ];
  return new Response(events.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function measured(input: ModelGatewayRequest, inputTokens = 3075): ModelProviderInputTokenMeasurement {
  return { inputTokens, source: "provider_input_token_count",
    providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(buildOpenAIInputTokenCountPayload(input)) };
}

async function invoke(input: ModelGatewayRequest, endpoint: "chat" | "raw", mode: OutputMode,
  inputTokenMeasurement?: ModelProviderInputTokenMeasurement) {
  const fetchImpl = vi.fn<typeof fetch>(async () => response(mode));
  const result = await createOpenAIProviderAdapter().invoke({
    endpoint, requestBody: input, invocation: resolveModelInvocation(input), fetchImpl,
    ...(inputTokenMeasurement ? { inputTokenMeasurement } : {}),
  });
  expect(result.kind).toBe(endpoint);
  let output = "";
  if (result.kind === "raw") output = String(result.body.text);
  if (result.kind === "chat") {
    const events: ModelGatewayEvent[] = [];
    await result.stream({ emit: (event) => events.push(event) });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    output = events.flatMap((event) => event.type === "content" ? [event.text] : []).join("");
  }
  expect(output).toBe(mode === "native" ? functionArguments : answer);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl.mock.calls[0]![0]).toBe("https://computed-output.test/v1/responses");
  return JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>;
}

beforeEach(() => vi.stubEnv("COMPUTED_OUTPUT_TEST_KEY", "fixture-only"));
afterEach(() => vi.unstubAllEnvs());

describe.each(["chat", "raw"] as const)("computed OpenAI output budget on %s wire", (endpoint) => {
  test.each(["native", "json", "plain"] as const)("sends a cap for %s output without adding provider calls", async (mode) => {
    const input = request(mode);
    expect(input.modelPolicy!.profiles!.luna).not.toHaveProperty("generation");
    const payload = await invoke(input, endpoint, mode, measured(input));
    expect(payload.max_output_tokens).toBe(27725);
    if (mode === "native") expect(payload.tool_choice).toEqual({ type: "function", name: controlsFormat.name });
    if (mode === "json") expect(payload.text).toMatchObject({ format: { type: "json_schema", name: "answer" } });
    if (mode === "plain") expect(payload).not.toHaveProperty("tools");
  });

  test("respects the known model output ceiling when context has more room", async () => {
    const input = request();
    input.modelPolicy!.profiles!.luna!.contextWindowTokens = 200000;
    const payload = await invoke(input, endpoint, "native", measured(input));
    expect(payload.max_output_tokens).toBe(128000);
  });

  test.each([
    { name: "explicit value", control: { mode: "value" as const, value: 4096 }, expected: 4096 },
    { name: "explicit omission", control: { mode: "omit" as const }, expected: undefined },
    { name: "invalid explicit value", control: { mode: "value" as const, value: 0 }, expected: undefined },
  ])("preserves $name without replacing it with a computed cap", async ({ control, expected }) => {
    const input = request("native", { parameters: { max_output_tokens: control } });
    const payload = await invoke(input, endpoint, "native", measured(input));
    if (expected === undefined) expect(payload).not.toHaveProperty("max_output_tokens");
    else expect(payload.max_output_tokens).toBe(expected);
  });
});

describe.each(["chat", "raw"] as const)("unknown OpenAI output capacity on %s wire", (endpoint) => {
  test.each([
    "unregistered-openai-model", "gpt-6-luna-latest", "gpt-6-luna-2099-01-01", "ft:gpt-6-luna:fixture",
  ])("preserves provider-default behavior for %s without guessing a known ceiling", async (model) => {
    const input = request();
    input.modelPolicy!.profiles!.luna!.model = model;
    const payload = await invoke(input, endpoint, "native", measured(input));
    expect(payload.model).toBe(model);
    expect(payload).not.toHaveProperty("max_output_tokens");
  });

  test.each([
    { name: "explicit value", control: { mode: "value" as const, value: 4096 }, expected: 4096 },
    { name: "explicit omission", control: { mode: "omit" as const }, expected: undefined },
  ])("preserves $name when no model output ceiling is declared", async ({ control, expected }) => {
    const input = request("native", { parameters: { max_output_tokens: control } });
    input.modelPolicy!.profiles!.luna!.model = "unregistered-openai-model";
    const payload = await invoke(input, endpoint, "native", measured(input));
    if (expected === undefined) expect(payload).not.toHaveProperty("max_output_tokens");
    else expect(payload.max_output_tokens).toBe(expected);
  });
});

test("input counting stays cap-free and its exact fingerprint reaches generation", async () => {
  const input = request();
  const invocation = resolveModelInvocation(input);
  const adapter = createOpenAIProviderAdapter();
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ input_tokens: 3075 }))
    .mockResolvedValueOnce(response("native"));
  const counted = await adapter.countInputTokens!({ endpoint: "raw", requestBody: input, invocation, fetchImpl });
  expect(counted.kind).toBe("counted");
  if (counted.kind !== "counted") throw new Error("expected counted provider input");
  const countPayload = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
  expect(countPayload).not.toHaveProperty("max_output_tokens");
  expect(countPayload).not.toHaveProperty("stream");
  expect(counted.providerEnvelopeFingerprint).toBe(createProviderEnvelopeFingerprint(countPayload));
  const result = await adapter.invoke({ endpoint: "raw", requestBody: input, invocation, fetchImpl,
    inputTokenMeasurement: { ...counted, source: "provider_input_token_count" } });
  expect(result).toMatchObject({ kind: "raw", body: { text: functionArguments } });
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "https://computed-output.test/v1/responses/input_tokens", "https://computed-output.test/v1/responses",
  ]);
  const generationPayload = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body));
  expect(generationPayload.max_output_tokens).toBe(27725);
  expect(createProviderEnvelopeFingerprint(generationPayload)).toBe(counted.providerEnvelopeFingerprint);
});

test("a stale count cannot replace the estimate for the actual provider envelope", async () => {
  const input = request();
  const withoutCount = await invoke(input, "raw", "native");
  const staleCount = await invoke(input, "raw", "native", {
    ...measured(input, 30000), providerEnvelopeFingerprint: "sha256:stale-envelope",
  });
  expect(staleCount.max_output_tokens).toBe(withoutCount.max_output_tokens);
  expect(staleCount.max_output_tokens).not.toBe(800);
});
