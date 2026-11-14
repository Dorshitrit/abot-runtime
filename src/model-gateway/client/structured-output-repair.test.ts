import { afterEach, expect, test, vi } from "vitest";
import { createModelGatewayClient } from "../client.js";
import { resolveModelInvocation } from "../policy/invocation-policy.js";
import { buildLlamaCppChatPayload } from "../providers/llamacpp/payload.js";
import { buildOllamaPayload } from "../providers/ollama/payload.js";
import { buildChatGptResponsesPayload } from "../providers/openai-chatgpt/payload.js";
import { buildOpenAIResponsesPayload } from "../providers/openai/payload.js";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../types.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({
  traceDebug: vi.fn(),
}));

const format = {
  type: "json_schema" as const,
  name: "repair_decision",
  strict: true,
  schema: {
    type: "object",
    properties: { decision: { type: "boolean" } },
    required: ["decision"],
    additionalProperties: false,
  },
};
const messages = [
  { role: "system" as const, content: "Return the supplied decision format." },
  { role: "user" as const, content: "Previous request" },
  { role: "assistant" as const, content: "Previous response" },
  { role: "user" as const, content: "Current request" },
];

function modelPolicy(
  type: "ollama" | "openai" | "openai-chatgpt" | "llamacpp",
): ModelGatewayPolicyConfig {
  return {
    providers: { fixture: { type } },
    profiles: {
      fixture: {
        provider: "fixture",
        model: "fixture-model",
        contextWindowTokens: 32_768,
        supportsThinking: true,
      },
    },
    defaults: { profileId: "fixture" },
  };
}

afterEach(() => vi.unstubAllGlobals());

test("carries format repair over JSON transport without persisting it on later invocations", async () => {
  const bodies: ModelGatewayRequest[] = [];
  const payloads: Record<string, unknown>[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("http://gateway.test/chat");
    const body = JSON.parse(String(init?.body)) as ModelGatewayRequest;
    bodies.push(body);
    payloads.push(buildOllamaPayload(body));
    return new Response([
      JSON.stringify({ type: "content", text: '{"decision":true}' }),
      JSON.stringify({ type: "done", reason: "stop" }),
      "",
    ].join("\n"));
  });
  vi.stubGlobal("fetch", fetchMock);
  const policy = modelPolicy("ollama");
  const originalPolicy = structuredClone(policy);
  const client = createModelGatewayClient({ baseUrl: "http://gateway.test", modelPolicy: policy });
  const input = {
    messages,
    format,
    agentMode: "deep" as const,
    modelStep: "supervisor.decision" as const,
    abortSignal: new AbortController().signal,
  };

  await client.invoke(input);
  await client.invoke({ ...input, structuredOutputRepair: "json_schema_violation" });
  await client.invoke(input);

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(bodies[0]).not.toHaveProperty("structuredOutputRepair");
  expect(bodies[1]).toEqual({ ...bodies[0], structuredOutputRepair: "json_schema_violation" });
  expect(bodies[2]).toEqual(bodies[0]);
  expect(payloads.map((payload) => payload.think)).toEqual(["high", false, "high"]);
  for (const payload of payloads) {
    expect(payload.messages).toEqual(messages);
    expect(payload.format).toEqual(format.schema);
    expect(payload).not.toHaveProperty("structuredOutputRepair");
  }
  expect(policy).toEqual(originalPolicy);
  expect(input).not.toHaveProperty("structuredOutputRepair");
});

test.each([
  ["openai", buildOpenAIResponsesPayload],
  ["openai-chatgpt", buildChatGptResponsesPayload],
  ["llamacpp", (requestBody: ModelGatewayRequest) => buildLlamaCppChatPayload({
    endpoint: "chat", requestBody, invocation: resolveModelInvocation(requestBody),
  })],
] as const)("%s payload is unchanged by the generic repair marker", (provider, build) => {
  const request: ModelGatewayRequest = {
    messages, format, agentMode: "deep", modelStep: "supervisor.decision",
    modelPolicy: modelPolicy(provider),
  };
  const baseline = build(request);
  const repaired = build({ ...request, structuredOutputRepair: "json_schema_violation" });

  expect(repaired).toEqual(baseline);
  expect(repaired).not.toHaveProperty("structuredOutputRepair");
});
