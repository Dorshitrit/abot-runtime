import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { projectChatGatewayMessages } from "../../model-gateway/client/message-projection.js";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-gateway/model-io-trace.js";
import { shouldUseStableExecutionContextPrefix } from "../../model-gateway/policy/context-prefix-policy.js";
import { resolveModelInvocation } from "../../model-gateway/policy/invocation-policy.js";
import type { ModelProviderInputTokenMeasurement } from "../../model-gateway/providers/contracts.js";
import { createLlamaCppProviderAdapter } from "../../model-gateway/providers/llamacpp/adapter.js";
import { renderLlamaCppTemplate, type TemplateMode } from "../../model-gateway/providers/llamacpp/__tests__/render-template-fixture.js";
import { countLlamaCppInputTokens } from "../../model-gateway/providers/llamacpp/input-token-count.js";
import type { ChatMessage, ModelGatewayPolicyConfig, ModelGatewayRequest } from "../../model-gateway/types.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient, ModelGatewayInvokeParams } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { supervisionStagedFixture, STAGED_FACT } from "./support/supervision-staged-fixture.js";

beforeEach(() => {
  configureDebugLogger({ enabled: false });
  configureModelIoTrace({ enabled: false });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected real network request"); }));
});
afterEach(() => {
  resetDebugLoggerConfig();
  resetModelIoTraceConfig();
  vi.unstubAllGlobals();
});

const localPolicy: ModelGatewayPolicyConfig = {
  providers: { local: { type: "llamacpp", baseUrl: "http://local.fixture" } },
  profiles: { "staged-super": {
    provider: "local", model: "fixture-model", contextWindowTokens: 32000,
    // An OpenAI option on another provider cannot activate the EA projection.
    options: { prompt_cache_options: { mode: "implicit" } },
  } },
  defaults: { profileId: "staged-super", steps: {} },
};
type CountInput = Parameters<NonNullable<ModelGatewayClient["countInputTokens"]>>[0];
type Wire = { step: string; url: string; body: Record<string, unknown> };

function gatewayRequest(input: ModelGatewayInvokeParams | CountInput): ModelGatewayRequest {
  return { modelPolicy: localPolicy, agentMode: input.agentMode,
    modelStep: input.modelStep, format: input.format, ...projectChatGatewayMessages(input) };
}

async function runSuper(template?: TemplateMode) {
  const fixture = supervisionStagedFixture("supervisor-worker-v1");
  const wire: Wire[] = [];
  const measured = new Map<string, ModelProviderInputTokenMeasurement>();
  let scriptedText = "";
  const adapter = createLlamaCppProviderAdapter();
  const params = (body: ModelGatewayRequest) => ({
    endpoint: "chat" as const, requestBody: body, invocation: resolveModelInvocation(body),
    fetchImpl: (async (url, init) => {
      const payload = JSON.parse(String(init?.body));
      wire.push({ step: body.modelStep!, url: String(url), body: payload });
      if (String(url) === "http://local.fixture/apply-template")
        return Response.json({ prompt: renderLlamaCppTemplate(payload.messages, template) });
      if (String(url) === "http://local.fixture/v1/chat/completions/input_tokens")
        return Response.json({ input_tokens: 1000 });
      expect(String(url)).toBe("http://local.fixture/v1/chat/completions");
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
        delta: { content: scriptedText }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }) satisfies typeof fetch,
  });
  const countInputTokens: NonNullable<ModelGatewayClient["countInputTokens"]> = async (input) => {
    const body = gatewayRequest(input);
    expect(shouldUseStableExecutionContextPrefix(body)).toBe(false);
    if (template) {
      const result = await countLlamaCppInputTokens(params(body));
      expect(result.kind).toBe("counted");
      if (result.kind !== "counted") throw new Error(result.message);
      measured.set(JSON.stringify(body), { ...result, source: "provider_input_token_count" });
    }
    return { inputTokens: 1000, profileId: "staged-super", provider: "llamacpp",
      model: "fixture-model", contextWindowTokens: 32000, source: "provider_input_token_count" };
  };
  const invoke: ModelGatewayClient["invoke"] = async (input) => {
    const expected = await fixture.invoke(input);
    if (!template) return expected;
    const body = gatewayRequest(input);
    const snapshot = JSON.stringify(body);
    const measurement = measured.get(snapshot);
    expect(measurement).toBeDefined();
    scriptedText = expected.text;
    const result = await adapter.invoke({ ...params(body), inputTokenMeasurement: measurement });
    expect(result.kind).toBe("chat");
    if (result.kind !== "chat") throw new Error("Expected a local scripted chat stream");
    let delivered = "";
    await result.stream({ emit(event) {
      if (event.type === "content") delivered += event.text;
      if (event.type === "error") throw new Error(event.error);
    } });
    expect(delivered).toBe(expected.text);
    expect(JSON.stringify(body)).toBe(snapshot);
    return { ...expected, text: delivered };
  };
  const request = deriveTestRequestExecutionScope(fixture.request, {
    modelPolicy: localPolicy,
    modelGatewayClient: { ...fixture.request.modelGatewayClient, invoke, countInputTokens },
  });
  const result = await runRequestRunner(request);
  return { fixture, wire, result };
}

test("SUPER keeps existing decisions, Controls and visible context through local llama.cpp count/send", async () => {
  const template = "all-roles";
  const control = await runSuper();
  const local = await runSuper(template);
  expect(local.result).toEqual(control.result);
  expect(local.result).toMatchObject({ output: STAGED_FACT });
  expect(local.fixture.calls).toEqual(control.fixture.calls);
  expect(local.fixture.execute.mock.calls.map(([input]) => input.controls)).toEqual([
    { query: "same-observation" }, { query: "same-observation" },
  ]);
  expect(local.fixture.execute.mock.calls.map(([input]) => input.controls))
    .toEqual(control.fixture.execute.mock.calls.map(([input]) => input.controls));
  const generated = local.wire.filter(({ url }) => url.endsWith("/chat/completions"));
  const counts = local.wire.filter(({ url }) => url.endsWith("/input_tokens"));
  expect(generated).toHaveLength(local.fixture.calls.length);
  expect(counts).toHaveLength(generated.length);
  for (const [index, sent] of generated.entries()) {
    expect(sent.step).toBe(counts[index]!.step);
    expect(sent.body).toEqual(counts[index]!.body);
    const source = local.fixture.calls[index]!.messages;
    const visible = renderLlamaCppTemplate(sent.body.messages, template);
    for (const message of source) {
      if (message.content) expect(visible).toContain(message.content);
      if ("toolCalls" in message && message.toolCalls)
        for (const call of message.toolCalls) expect(visible).toContain(call.arguments);
    }
    expect(sent.body).not.toHaveProperty("prompt_cache_key");
    expect(sent.body).not.toHaveProperty("prompt_cache_options");
    expect(JSON.stringify(source)).not.toContain("runtime_execution_decision_contract_v1");
  }
  const controls = local.fixture.invoke.mock.calls.filter(([input]) => input.modelStep === "capability.controls");
  expect(controls).toHaveLength(3);
  for (const [input] of controls) {
    expect(JSON.stringify(input.format)).not.toContain('"capabilityId"');
    expect((input.messages as ChatMessage[]).some(({ content }) =>
      content.includes('"kind":"runtime_worker_capability_execution_assignment"'))).toBe(true);
  }
  expect(new Set(local.fixture.calls.map(({ step }) => step))).toEqual(new Set([
    "supervisor.decision", "planner.decision", "worker.decision",
    "capability.controls", "reviewer.decision", "supervisor.response",
  ]));
  expect(fetch).not.toHaveBeenCalled();
});
