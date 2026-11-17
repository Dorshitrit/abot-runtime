import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { projectInvocationReasoning } from "../model/invocation-reasoning-presentation.js";
import { RequestModelStepInvoker } from "../model/invoke-step.js";
import type { RequestModelInvocationView } from "../request/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const modelPolicy: ModelGatewayPolicyConfig = {
  providers: { native: { type: "llamacpp" } },
  profiles: { local: { provider: "native", model: "local", contextWindowTokens: 32000, supportsThinking: true,
    generation: { reasoningEffort: "high" }, calibration: { utility: { generation: { reasoningEffort: "none" } } } } },
  defaults: { profileId: "local", steps: { "context.compact": "utility" } },
};

describe("resolved reasoning presentation", () => {
  test("uses effective configuration and request budgets rather than the generic agent mode", () => {
    const invocation = resolveModelInvocation({ modelPolicy, agentMode: "fast", modelStep: "execution.decision",
      reasoningPreference: { profileId: "local", mode: "budget", budgetTokens: 80 } });
    expect(projectInvocationReasoning(invocation)).toEqual({ reasoningEffort: "high", reasoningBudget: { mode: "tokens", tokens: 80 }, reasoningControlSource: "request" });
    const utility = resolveModelInvocation({ modelPolicy, agentMode: "deep", modelStep: "context.compact" });
    expect(projectInvocationReasoning(utility).reasoningEffort).toBe("none");
  });

  test("preserves provider-default omission and explicit disabled reasoning", () => {
    const invocation = resolveModelInvocation({ modelPolicy, agentMode: "fast" });
    expect(projectInvocationReasoning({ ...invocation, think: undefined, reasoningBudget: undefined, reasoningControlSource: undefined })).toEqual({});
    expect(projectInvocationReasoning({ ...invocation, think: "none" })).toMatchObject({ reasoningEffort: "none" });
  });

  test("context snapshots carry the invocation's reasoning without modifying the provider request", async () => {
    const invoke = vi.fn(async (_input: unknown) => ({ text: "ok", meta: {} }));
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const request: RequestModelInvocationView = {
      requestId: "request", agentMode: "fast", modelPolicy,
      reasoningPreference: { profileId: "local", mode: "budget", budgetTokens: 80 },
      runnerConfig: { models: { defaults: { profileId: "local", steps: {} } }, context: {
        outputReserveTokens: 100, safetyReserveTokens: 50, attachmentReserveTokens: 10 },
      steps: { "execution.decision": { timeoutMs: 1000 } } },
      modelGatewayClient: { invoke, invokeRaw: vi.fn() }, abortSignal: new AbortController().signal,
      onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(),
    };
    const invoker = new RequestModelStepInvoker(request, (name, payload) => events.push([name, payload]));
    await invoker.invoke({ modelStep: "execution.decision", messages: [{ role: "user", content: "Hello" }],
      timeoutReason: "test_timeout", accept: (text) => text });
    expect(events).toContainEqual(["context.window.snapshot", expect.objectContaining({
      profileId: "local", reasoningEffort: "high", reasoningBudget: { mode: "tokens", tokens: 80 }, reasoningControlSource: "request" })]);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ agentMode: "fast", reasoningPreference: request.reasoningPreference }));
    expect(invoke.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
  });
});
