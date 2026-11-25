import { afterEach, expect, test, vi } from "vitest";
import { MODEL_PARAMETER_DEFINITIONS } from "../../shared/model-parameter-validation.js";
import type { ModelGatewayRequest, ModelGenerationConfig, ResolvedModelInvocation } from "../types.js";
import { resolveModelInvocation } from "../policy/invocation-policy.js";
import { readModelParameterOmissions } from "../protocol/parameter-omissions.js";
import { observeParameterOmissions } from "./parameter-issues.js";
import { createOpenAIProviderAdapter } from "./openai/adapter.js";
import { createChatGptProviderAdapter } from "./openai-chatgpt/adapter.js";
import { createLlamaCppProviderAdapter } from "./llamacpp/adapter.js";
import { createOllamaProviderAdapter } from "./ollama/adapter.js";
import { createChatHandler } from "../server/chat-handler.js";
import { createRawHandler } from "../server/raw-handler.js";
import { createInputTokenCountHandler } from "../server/input-token-count-handler.js";
import { invokeModelGatewayWithOptions } from "../client/chat.js";
import { invokeRawModelGatewayWithOptions } from "../client/raw.js";
import { countModelGatewayInputTokensWithOptions } from "../client/input-token-count.js";
import { ClientModelIssues } from "../client/model-issues.js";
import { GatewayModelIssues } from "../server/model-issues.js";
import { decodeModelIssues, MODEL_ISSUE_HEADER, type ModelIssueDiagnostic } from "../protocol/model-issue.js";
import type { GatewayResponse } from "../server/contracts.js";
import { readSourceIssueId } from "../../shared/source-issue.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
vi.mock("../observability/trace-store.js", () => ({ isModelIoTraceEnabled: () => false, traceModelIo: vi.fn(async () => {}) }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function request(provider: string, generation: ModelGenerationConfig = {
  parameters: { reasoning_effort: { mode: "value", value: "none" } },
}, providerId = "local"): ModelGatewayRequest {
  return { agentMode: "fast", modelStep: "supervisor.response", text: "private input",
    messages: [{ role: "user", content: "private input" }], modelPolicy: {
      providers: { [providerId]: provider === "openai-chatgpt"
        ? { type: provider, settings: { accountRef: "12345678-1234-4123-8123-123456789abc" } }
        : { type: provider, baseUrl: "http://127.0.0.1:1234", apiKeyEnv: "LOCAL_OMISSION_TEST_KEY" } },
      profiles: { local: { provider: providerId, model: "fixture-model", supportsThinking: true, contextWindowTokens: 8192, generation } },
      defaults: { profileId: "local" }, parameterProfiles: { schemaVersion: 1, revision: "fixture", diagnostics: [], profiles: [{
        schemaVersion: 1, id: "fixture-parameters", match: [{ kind: "exact", pattern: "fixture-model" }],
        reasoning: { efforts: ["low", "high"], mappings: { none: null, xhigh: "high" }, canDisableThinking: false },
      }] },
    } };
}

test("only final field omissions become one aggregate and input facts remain immutable", () => {
  const invocation = resolveModelInvocation(request("openai"));
  const before = structuredClone(invocation);
  const onIssue = vi.fn();
  observeParameterOmissions({ invocation, operation: "chat", onIssue });
  expect(onIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    code: "model_parameter_omitted", outcome: "recovered", recovery: "parameter_omitted",
    parameterOmissions: [{ parameter: "reasoning_effort", reasonCode: "model_reasoning_effort_omitted", requestedValue: "none" }],
  }));
  expect(invocation).toEqual(before);
  expect(JSON.stringify(onIssue.mock.calls)).not.toContain("private input");
});

test.each(["high", "omit"])("request override reports actual none instead of saved %s and leaves payload unchanged", async (saved) => {
  vi.stubEnv("LOCAL_OMISSION_TEST_KEY", "fixture-only");
  const requestBody = request("openai", { parameters: { reasoning_effort: saved === "omit"
    ? { mode: "omit" } : { mode: "value", value: saved } } });
  requestBody.reasoningOverride = "none";
  const before = structuredClone(requestBody);
  const onIssue = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("failure", { status: 503 }));
  const adapter = createOpenAIProviderAdapter();
  const params = { endpoint: "chat" as const, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
  await adapter.invoke(params);
  await adapter.invoke({ ...params, onIssue });
  expect(onIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    parameterOmissions: [{ parameter: "reasoning_effort", reasonCode: "model_reasoning_effort_omitted", requestedValue: "none" }],
  }));
  expect(fetchImpl.mock.calls[1]![1]!.body).toBe(fetchImpl.mock.calls[0]![1]!.body);
  expect(requestBody).toEqual(before);
});

test.each(["off", "budget"] as const)("applied session %s preference supersedes saved control diagnostics", (mode) => {
  const requestBody = request("llamacpp", { parameters: { reasoning_effort: { mode: "value", value: "high" } } });
  requestBody.reasoningPreference = mode === "off" ? { profileId: "local", mode }
    : { profileId: "local", mode, budgetTokens: 0 };
  const onIssue = vi.fn();
  const invocation = resolveModelInvocation(requestBody);
  observeParameterOmissions({ invocation, requestBody, operation: "chat", onIssue });
  expect(onIssue.mock.calls[0]![0].parameterOmissions).toContainEqual({
    parameter: "reasoning_effort", reasonCode: "model_reasoning_effort_omitted", requestedValue: "none",
  });
});

test("a superseded budget reports exact request tokens and ambiguous derived effort omits its saved value", () => {
  const requestBody = request("llamacpp", { parameters: {
    thinking_budget: { mode: "value", value: 20 }, reasoning_effort: { mode: "value", value: "high" },
  } });
  requestBody.reasoningPreference = { profileId: "local", mode: "budget", budgetTokens: 100 };
  const profile = requestBody.modelPolicy!.parameterProfiles!.profiles[0]!;
  requestBody.modelPolicy!.parameterProfiles = { ...requestBody.modelPolicy!.parameterProfiles!, profiles: [{
    ...profile, constraints: { thinking_budget: { max: 50 }, reasoning_effort: { values: ["low"] } },
  }] };
  const onIssue = vi.fn();
  observeParameterOmissions({ invocation: resolveModelInvocation(requestBody), requestBody, operation: "chat", onIssue });
  const facts = onIssue.mock.calls[0]![0].parameterOmissions;
  expect(facts).toContainEqual({ parameter: "thinking_budget", reasonCode: "model_parameter_value_omitted", requestedValue: "100" });
  expect(facts.find((fact: { parameter: string }) => fact.parameter === "reasoning_effort")).not.toHaveProperty("requestedValue");
});

test.each([
  { parameters: { reasoning_effort: { mode: "omit" as const } } },
  { parameters: { reasoning_effort: { mode: "value" as const, value: "xhigh" } } },
  { parameters: { reasoning_effort: { mode: "value" as const, value: "high" } } },
  { reasoningEffort: "high" as const, reasoningBudget: { mode: "server-default" as const } },
])("intentional omission, server defaults and supported values/mappings are quiet: %j", (generation) => {
  const invocation = resolveModelInvocation(request("llamacpp", generation));
  const onIssue = vi.fn();
  observeParameterOmissions({ invocation, operation: "raw", onIssue });
  expect(onIssue).not.toHaveBeenCalled();
});

test("computed omission retains earlier field reason and suppresses warning-free/global diagnostics", () => {
  const invocation = resolveModelInvocation(request("ollama"));
  const original = invocation.parameters!;
  const field = original.fields.reasoning_effort!;
  const parameters = { ...original, fields: { ...original.fields, reasoning_effort: { ...field, warnings: [] } } };
  const onIssue = vi.fn();
  observeParameterOmissions({ invocation, parameters, operation: "raw", onIssue });
  expect(onIssue.mock.calls[0]![0].parameterOmissions).toHaveLength(1);
  observeParameterOmissions({ invocation: { ...invocation, parameters: { ...parameters, warnings: original.warnings } },
    operation: "raw", onIssue });
  expect(onIssue).toHaveBeenCalledOnce();
});

test("all nine canonical omissions fit one immutable occurrence and unsafe scalar text is omitted", () => {
  const invocation = resolveModelInvocation(request("openai"));
  const fields = Object.fromEntries(MODEL_PARAMETER_DEFINITIONS.map(({ key }) => [key, {
    key, control: { mode: "value", value: "private arbitrary text" }, source: "manual", supported: false,
    modelSupport: "unsupported", omitted: true, explicit: true,
    warnings: [{ key, code: "model_parameter_unsupported", message: "private warning body" }],
  }]));
  const input = { ...invocation, parameters: { values: {}, controls: {}, fields, warnings: [] } } as ResolvedModelInvocation;
  const onIssue = vi.fn();
  observeParameterOmissions({ invocation: input, operation: "chat", onIssue });
  const issue = onIssue.mock.calls[0]![0];
  expect(onIssue).toHaveBeenCalledOnce();
  expect(issue.parameterOmissions).toHaveLength(9);
  expect(JSON.stringify(issue)).not.toContain("private");
  expect(readModelParameterOmissions(issue.parameterOmissions)).toEqual(issue.parameterOmissions);
  expect(Object.isFrozen(issue.parameterOmissions)).toBe(true);
});

test.each(["openai", "openai-chatgpt", "llamacpp", "ollama"])("%s chat/raw adapter observes omission without changing payload bytes", async (provider) => {
  vi.stubEnv("LOCAL_OMISSION_TEST_KEY", "fixture-only");
  const adapter = provider === "openai" ? createOpenAIProviderAdapter()
    : provider === "openai-chatgpt" ? createChatGptProviderAdapter({ getAccessToken: async () => "fixture-only" })
    : provider === "llamacpp" ? createLlamaCppProviderAdapter()
    : createOllamaProviderAdapter({ fallbackUrl: "http://127.0.0.1:1234" });
  for (const endpoint of ["chat", "raw"] as const) {
    const requestBody = request(provider);
    const before = structuredClone(requestBody);
    const onIssue = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("failure", { status: 503 }));
    const params = { endpoint, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
    await adapter.invoke(params);
    await adapter.invoke({ ...params, onIssue });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![1]!.body).toBe(fetchImpl.mock.calls[0]![1]!.body);
    expect(onIssue).toHaveBeenCalledOnce();
    expect(onIssue.mock.calls[0]![0]).toMatchObject({ code: "model_parameter_omitted", operation: endpoint,
      outcome: "recovered", parameterOmissions: [expect.objectContaining({ parameter: "reasoning_effort" })] });
    expect(requestBody).toEqual(before);
  }
});

test("malformed aggregate rejects unsafe facts without retaining their raw properties", () => {
  const fact = { parameter: "reasoning_effort", reasonCode: "model_reasoning_effort_omitted", requestedValue: "none" };
  expect(readModelParameterOmissions([{ ...fact, message: "private" }])).toEqual([fact]);
  for (const value of [[fact, fact], [{ ...fact, parameter: "unknown" }],
    [{ ...fact, reasonCode: "provider_text" }], [{ ...fact, requestedValue: "private string" }], []]) {
    expect(readModelParameterOmissions(value)).toBeUndefined();
  }
});

function responseCapture() {
  const headers = new Headers();
  let body = "";
  const response: GatewayResponse = { statusCode: 200,
    setHeader: (key, value) => { headers.set(key, String(value)); },
    write: (chunk) => { body += chunk; }, end: (chunk = "") => { body += chunk; } };
  return { response, headers, body: () => body };
}

test.each([
  ["chat", "OpenAI Primary"], ["raw", "ספק ראשי"], ["input_tokens", "主要供应商"],
] as const)("%s transports configured provider %s exactly and never attributes subsequent failure to an omission", async (operation, providerId) => {
  vi.stubEnv("LOCAL_OMISSION_TEST_KEY", "fixture-only");
  for (const failed of [false, true]) {
    const requestBody = request("openai", undefined, providerId);
    const before = structuredClone(requestBody);
    const frames = 'data: {"type":"response.output_text.delta","delta":"answer"}\n\n'
      + 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
    const providerFetch = vi.fn<typeof fetch>(async () => failed ? new Response("private failure", { status: 503 })
      : operation === "input_tokens" ? Response.json({ input_tokens: 7 }) : new Response(frames));
    const options = { modelPolicy: requestBody.modelPolicy, fetchImpl: providerFetch };
    const handler = operation === "chat" ? createChatHandler(options)
      : operation === "raw" ? createRawHandler(options) : createInputTokenCountHandler(options);
    let sentHeader: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const capture = responseCapture();
      await handler(JSON.parse(String(init.body)), capture.response);
      sentHeader = capture.headers.get(MODEL_ISSUE_HEADER);
      return new Response(capture.body(), { status: capture.response.statusCode, headers: capture.headers });
    }));
    const onIssue = vi.fn();
    const params = { agentMode: "fast" as const, modelStep: "supervisor.response" as const,
      abortSignal: new AbortController().signal, onIssue };
    const promise = operation === "chat" ? invokeModelGatewayWithOptions({ ...params, messages: requestBody.messages })
      : operation === "raw" ? invokeRawModelGatewayWithOptions({ ...params, prompt: "private input" })
      : countModelGatewayInputTokensWithOptions({ ...params, provider: "openai", messages: requestBody.messages });
    const result = await promise.catch((error: unknown) => error);
    if (failed) {
      expect(result).toBeInstanceOf(Error);
      expect(readSourceIssueId(result)).toBeUndefined();
    } else if (operation !== "input_tokens") expect(result).toHaveProperty("text", "answer");
    expect(onIssue).toHaveBeenCalledOnce();
    const issue = onIssue.mock.calls[0]![0];
    expect(issue).toMatchObject({ operation, providerId, code: "model_parameter_omitted", outcome: "recovered", recovery: "parameter_omitted" });
    expect(decodeModelIssues(sentHeader)[0]!.providerId).toBe(providerId);
    expect(issue.issueId).toBe(decodeModelIssues(sentHeader)[0]!.issueId);
    expect(issue.occurredAt).toBe(decodeModelIssues(sentHeader)[0]!.occurredAt);
    expect(JSON.stringify(issue)).not.toContain("private");
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(requestBody).toEqual(before);
  }
});

test.each(["openai", "llamacpp"])("%s input counting keeps exact provider payload with and without diagnostics", async (provider) => {
  vi.stubEnv("LOCAL_OMISSION_TEST_KEY", "fixture-only");
  const adapter = provider === "openai" ? createOpenAIProviderAdapter() : createLlamaCppProviderAdapter();
  const requestBody = request(provider);
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ input_tokens: 7 }));
  const onIssue = vi.fn();
  const params = { endpoint: "chat" as const, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
  await adapter.countInputTokens!(params);
  await adapter.countInputTokens!({ ...params, onIssue });
  expect(fetchImpl.mock.calls[1]![1]!.body).toBe(fetchImpl.mock.calls[0]![1]!.body);
  expect(onIssue).toHaveBeenCalledOnce();
  expect(onIssue.mock.calls[0]![0]).toMatchObject({ operation: "input_tokens", code: "model_parameter_omitted" });
});

test("nine maximum safe facts use one slot and preserve provider rejection capacity and header bounds", () => {
  const parameterOmissions = MODEL_PARAMETER_DEFINITIONS.map(({ key }) => ({ parameter: key,
    reasonCode: "model_parameter_requirement_unsatisfied" as const, requestedValue: String(-Number.MAX_VALUE) }));
  const local: ModelIssueDiagnostic = { issueId: "l".repeat(64), occurredAt: Number.MAX_SAFE_INTEGER,
    profileId: "字".repeat(160), model: "字".repeat(160), provider: "openai", providerId: "供".repeat(160),
    code: "model_parameter_omitted", operation: "input_tokens", recovery: "parameter_omitted", outcome: "recovered", parameterOmissions };
  const provider: ModelIssueDiagnostic = { ...local, issueId: "r".repeat(64), parameterOmissions: undefined,
    code: "model_reasoning_rejected", outcome: "pending", recovery: "provider_default", parameter: "reasoning_effort", requestedValue: "none" };
  const gateway = new GatewayModelIssues();
  gateway.observe(local);
  gateway.observe(provider);
  const capture = responseCapture();
  gateway.writeHeader(capture.response);
  const header = capture.headers.get(MODEL_ISSUE_HEADER)!;
  expect(header.length).toBeLessThanOrEqual(12_000);
  expect(decodeModelIssues(header)).toHaveLength(2);
  expect(decodeModelIssues(header).map((issue) => issue.providerId)).toEqual([local.providerId, provider.providerId]);
  const observed = vi.fn();
  const client = new ClientModelIssues(observed);
  client.readHeader(new Response(null, { headers: capture.headers }));
  gateway.observe({ ...provider, outcome: "failed" });
  gateway.writeStreamOutcomes(capture.response);
  for (const line of capture.body().trim().split("\n")) client.observe(JSON.parse(line).diagnostic);
  client.finish("failed");
  expect(observed).toHaveBeenCalledTimes(2);
  expect(observed.mock.calls.map(([issue]) => issue.code)).toEqual(["model_parameter_omitted", "model_reasoning_rejected"]);
  expect(observed.mock.calls.map(([issue]) => issue.providerId)).toEqual([local.providerId, provider.providerId]);
  expect(observed.mock.calls[0]![0].parameterOmissions).toHaveLength(9);
});
