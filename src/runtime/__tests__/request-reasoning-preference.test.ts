import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { resolveModelSelection } from "../model/model-selection.js";
import { captureRequestReasoningPreference } from "../request/reasoning-preference.js";
import { snapshotRequestSeed } from "../request/approval-wait/snapshot.js";
import { createRequestExecutionScope, type RequestCapabilityCompositionView } from "../request/execution-scope.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

const policy: ModelGatewayPolicyConfig = {
  providers: { native: { type: "llamacpp" }, cloud: { type: "openai" } },
  profiles: {
    gemma: { provider: "native", model: "gemma", contextWindowTokens: 32000, supportsThinking: true, generation: { reasoningEffort: "none" } },
    other: { provider: "cloud", model: "other", contextWindowTokens: 32000, supportsThinking: true },
    plain: { provider: "native", model: "plain", contextWindowTokens: 32000, supportsThinking: false },
  },
  invocationProfiles: { alias: { profileId: "gemma", generation: { temperature: 0.3 } } },
  defaults: { profileId: "gemma" },
};
function selection(profileId?: string, modelPolicy = policy) {
  return resolveModelSelection({ agentMode: "fast", modelPreference: profileId ? { profileId, scope: "all" } : undefined, modelPolicy });
}
function seed(reasoningPreference?: RequestExecutionSeed["reasoningPreference"]): RequestExecutionSeed {
  return {
    requestId: "reasoning-request", sessionId: "reasoning-session", prompt: "Keep request controls.",
    historyMessages: [], shouldGenerateSessionTitle: false,
    runnerConfig: { models: { defaults: { profileId: "gemma", steps: {} } }, context: {
      outputReserveTokens: 128, safetyReserveTokens: 64, attachmentReserveTokens: 32,
    }, steps: {} },
    agentMode: "fast", modelPreference: { profileId: "alias", scope: "all" }, modelPolicy: policy,
    ...(reasoningPreference ? { reasoningPreference } : {}),
    modelGatewayClient: { invoke: vi.fn(), invokeRaw: vi.fn() },
    toolPermissionMode: "ask", abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  };
}
function scope(input: RequestExecutionSeed) {
  let composition: RequestCapabilityCompositionView | undefined;
  const request = createRequestExecutionScope({
    seed: input, executionPolicy: EXECUTION_AGENT_V1_EXECUTION_POLICY,
    createWorkerCapabilities(view) {
      composition = view;
      return { getDescriptors: () => [], getAdapters: () => [] };
    },
  });
  return { request, composition: composition! };
}
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("request reasoning control capture", () => {
  test.each(["gemma", "alias", undefined])("binds %s selection to its physical profile and gateway invocation", (profileId) => {
    const modelSelection = selection(profileId);
    const preference = captureRequestReasoningPreference({ profileId: "gemma", mode: "budget", budgetTokens: 64 }, modelSelection);
    expect(preference).toEqual({ profileId: "gemma", mode: "budget", budgetTokens: 64 });
    const invocation = resolveModelInvocation({
      agentMode: "fast", modelStep: "execution.decision", modelPolicy: policy,
      modelPreference: modelSelection.modelPreference, reasoningPreference: preference,
    });
    expect(invocation.profile.id).toBe("gemma");
    expect(invocation).toMatchObject({ think: "medium", reasoningBudget: { mode: "tokens", tokens: 64 } });
  });
  test("resolves a configured invocation alias when the request omits modelPreference", () => {
    const modelPolicy = { ...policy, defaults: { profileId: "alias" } };
    expect(captureRequestReasoningPreference({ profileId: "gemma", mode: "off" }, selection(undefined, modelPolicy)))
      .toEqual({ profileId: "gemma", mode: "off" });
  });
  test("requires a physical preference binding and does not silently rebind a mismatched selection", () => {
    expect(() => captureRequestReasoningPreference({ profileId: "alias", mode: "off" }, selection("alias")))
      .toThrow("reasoning_preference_profile_mismatch");
    expect(() => captureRequestReasoningPreference({ profileId: "gemma", mode: "off" }, selection("other")))
      .toThrow("reasoning_preference_profile_mismatch");
    expect(() => captureRequestReasoningPreference({ profileId: "gemma", mode: "off" }, selection("missing")))
      .toThrow("reasoning_preference_profile_mismatch");
  });
  test.each(["other", "plain"])("rejects unsupported selected profile %s at capture", (profileId) => {
    expect(() => captureRequestReasoningPreference({ profileId, mode: "budget", budgetTokens: 50 }, selection(profileId)))
      .toThrow("reasoning_budget_unsupported");
  });
  test("captures a frozen copy before caller input can change", () => {
    const input = { profileId: "gemma", mode: "budget", budgetTokens: 80 };
    const captured = captureRequestReasoningPreference(input, selection("alias"));
    input.budgetTokens = 900;
    input.profileId = "other";
    expect(captured).toEqual({ profileId: "gemma", mode: "budget", budgetTokens: 80 });
    expect(Object.isFrozen(captured)).toBe(true);
  });
  test("validates malformed controls and keeps legacy omission absent", () => {
    expect(() => captureRequestReasoningPreference({ profileId: "gemma", mode: "budget", budgetTokens: -1 }, selection()))
      .toThrow("invalid_reasoning_preference");
    expect(captureRequestReasoningPreference(undefined, selection("alias"))).toBeUndefined();
  });
});

describe("reasoning preference lifecycle surfaces", () => {
  test("preserves one frozen control across model and capability views and a serialized snapshot", () => {
    const captured = captureRequestReasoningPreference({ profileId: "gemma", mode: "budget", budgetTokens: 80 }, selection("alias"));
    const initial = scope(seed(captured));
    for (const view of [initial.request, initial.request.model, initial.request.modelInvocation,
      initial.composition, initial.request.capabilities.executionContext]) {
      expect(view.reasoningPreference).toBe(captured);
      expect(Object.isFrozen(view)).toBe(true);
    }
    expect(initial.request.input).not.toHaveProperty("reasoningPreference");
    const snapshot = snapshotRequestSeed(initial.request);
    expect(snapshot.reasoningPreference).toEqual(captured);
    expect(snapshot.reasoningPreference).not.toBe(captured);
    const serialized = JSON.parse(JSON.stringify(snapshot));
    const restored = scope({ ...seed(), ...serialized });
    expect(restored.request.modelInvocation.reasoningPreference).toEqual(captured);
    expect(resolveModelInvocation({
      ...restored.request.modelInvocation, modelStep: "execution.response",
    }).reasoningBudget).toEqual({ mode: "tokens", tokens: 80 });
    const utility = resolveModelInvocation({ ...restored.request.modelInvocation, modelStep: "context.compact" });
    expect(utility.think).toBe("none");
    expect(utility).not.toHaveProperty("reasoningBudget");
    const next = scope(seed(captureRequestReasoningPreference({ profileId: "gemma", mode: "off" }, selection("alias"))));
    expect(next.request.reasoningPreference?.mode).toBe("off");
    expect(restored.request.reasoningPreference?.mode).toBe("budget");
  });
  test("legacy scopes and snapshots gain no absent reasoning fields", () => {
    const legacy = scope(seed());
    for (const view of [legacy.request, legacy.request.model, legacy.request.modelInvocation,
      legacy.composition, legacy.request.capabilities.executionContext, snapshotRequestSeed(legacy.request)]) {
      expect(view).not.toHaveProperty("reasoningPreference");
    }
  });
  test("a profile-switch calibration keeps the original preference but does not apply it to the replacement", () => {
    const modelPolicy: ModelGatewayPolicyConfig = {
      ...policy,
      profiles: { ...policy.profiles, gemma: { ...policy.profiles!.gemma!,
        calibration: { decision: { profileId: "other" } } } },
      defaults: { profileId: "gemma", steps: { "execution.decision": "decision" } },
    };
    const reasoningPreference = captureRequestReasoningPreference({ profileId: "gemma", mode: "budget", budgetTokens: 80 }, selection("alias", modelPolicy));
    const invocation = resolveModelInvocation({ modelPolicy, modelPreference: { profileId: "alias" },
      reasoningPreference, agentMode: "fast", modelStep: "execution.decision" });
    expect(invocation.profile.id).toBe("other");
    expect(invocation.think).toBe("none");
    expect(invocation).not.toHaveProperty("reasoningBudget");
  });
});
