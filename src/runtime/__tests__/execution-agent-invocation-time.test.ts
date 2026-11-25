import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage, ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { isInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import { createProviderEnvelopeFingerprint } from "../../model-gateway/providers/envelope-budget.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runExecutionAgentDecision } from "../steps/execution-agent/run.js";
import { activeEvidenceCall, createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";

const requestTime = Object.freeze({ currentDateTime: "2026-11-21 23:59:00 GMT", timeZone: "UTC" });
const invocationKind = "runtime_invocation_time_v1";
const requestKind = "runtime_request_time_v1";
const stableReply = { text: JSON.stringify({ decision: {
  action: "respond",
} }), meta: {} };
type Fixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

function options(f: Fixture) {
  const head = f.ledger.current();
  return { head, call: activeEvidenceCall(head), steeringSnapshot: f.steering.snapshot(),
    includeAcknowledgement: false, includeTitle: false, allowPlanner: false, allowAuditor: false };
}

function capsules(messages: readonly ChatMessage[], kind: string) {
  return messages.flatMap((message) => {
    try {
      const value = JSON.parse(message.content ?? "") as Record<string, unknown>;
      return value?.kind === kind ? [{ message, value }] : [];
    } catch { return []; }
  });
}

function assertClock(messages: readonly ChatMessage[], expectedTime: string) {
  const clocks = capsules(messages, invocationKind);
  expect(clocks).toHaveLength(1);
  const { message, value } = clocks[0]!;
  expect(message).toBe(messages.at(-1));
  expect(message.role).toBe("system");
  expect(Object.isFrozen(message)).toBe(true);
  expect(isInvocationContextMessage(message)).toBe(true);
  expect(value).toMatchObject({ kind: invocationKind, timeZone: "UTC", requestTimeReference: requestKind });
  expect(String(value.currentDateTime)).toMatch(new RegExp(`^${expectedTime} GMT(?:\\+00:00)?$`));
  expect(capsules(messages, requestKind).map(({ value: anchor }) => anchor)).toEqual([
    { kind: requestKind, ...requestTime, passive: "relative_time_reference_not_user_intent" },
  ]);
  return message;
}

async function fixture(modelPolicy: ModelGatewayPolicyConfig = executionPrefixCachePolicy) {
  const f = await createControlsEvidenceFixture({ modelPolicy, temporalContext: requestTime,
    historyMessages: [
      { id: "prior-user", role: "user", content: "Keep the original evidence.", createdAt: "2026-11-21T22:00:00Z" },
      { id: "prior-answer", role: "assistant", content: "Evidence retained.", createdAt: "2026-11-21T22:00:01Z" },
    ],
  });
  f.invoke.mockResolvedValue(stableReply);
  return f;
}

function assertCountedEnvelopes(f: Fixture) {
  const sent = f.invoke.mock.calls.map(([input]) => input);
  const counted = f.countInputTokens.mock.calls.map(([input]) => input);
  expect(counted).toHaveLength(sent.length);
  for (const [index, invocation] of sent.entries()) {
    expect(counted[index]!.messages).toEqual(invocation.messages);
    expect((counted[index]!.messages as ChatMessage[]).at(-1)).toBe((invocation.messages as ChatMessage[]).at(-1));
    expect(createProviderEnvelopeFingerprint(buildOpenAIInputTokenCountPayload(counted[index]!)))
      .toBe(createProviderEnvelopeFingerprint(buildOpenAIResponsesPayload(invocation)));
  }
  return sent;
}

test("actual EA calls refresh only the last clock while count, send and request evidence remain bound", async () => {
  const f = await fixture();
  f.steering.append({ steerId: "current-direction", text: "Keep the same bounded objective." });
  const originalHistory = JSON.stringify(f.request.historyMessages);
  const originalHead = f.ledger.current();
  const originalLedger = JSON.stringify(originalHead);
  let now = Date.parse("2026-11-22T08:00:01Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.countInputTokens.mockImplementation(async (input) => {
    now += 70_000;
    const invocation = resolveModelInvocation(input);
    return { inputTokens: 1000, profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count" };
  });

  await expect(runExecutionAgentDecision(f.request, options(f))).resolves.toMatchObject({ decision: { action: "respond" } });
  now = Date.parse("2026-11-22T09:00:02Z");
  await expect(runExecutionAgentDecision(f.request, options(f))).resolves.toMatchObject({ decision: { action: "respond" } });

  const sent = assertCountedEnvelopes(f);
  expect(sent).toHaveLength(2);
  const first = sent[0]!.messages as ChatMessage[], second = sent[1]!.messages as ChatMessage[];
  assertClock(first, "2026-11-22 08:00:01");
  assertClock(second, "2026-11-22 09:00:02");
  expect(JSON.stringify(second.slice(0, -1))).toBe(JSON.stringify(first.slice(0, -1)));
  const payloads = sent.map((input) => buildOpenAIResponsesPayload(input));
  expect(JSON.stringify((payloads[1]!.input as unknown[]).slice(0, -1)))
    .toBe(JSON.stringify((payloads[0]!.input as unknown[]).slice(0, -1)));
  expect(payloads[1]!.tools).toEqual(payloads[0]!.tools);
  expect(payloads[1]!.prompt_cache_key).toBe(payloads[0]!.prompt_cache_key);
  expect(typeof payloads[0]!.prompt_cache_key).toBe("string");
  expect(sent[0]!.promptCacheBoundaryBeforeMessageIndex).toBeGreaterThan(0);
  expect(sent[1]!.promptCacheBoundaryBeforeMessageIndex).toBe(sent[0]!.promptCacheBoundaryBeforeMessageIndex);
  expect(JSON.stringify(f.request.historyMessages)).toBe(originalHistory);
  expect(f.ledger.current()).toBe(originalHead);
  expect(JSON.stringify(f.ledger.current())).toBe(originalLedger);
  expect(f.request.temporalContext).toEqual(requestTime);
});

test("actual EA structured repair has a fresh final clock without retaining the prior clock", async () => {
  const f = await fixture();
  let now = Date.parse("2026-11-22T08:00:01Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.invoke.mockImplementationOnce(async () => {
    now = Date.parse("2026-11-22T08:01:02Z");
    return { text: JSON.stringify({ decision: { action: "unsupported-action" } }), meta: {} };
  });
  const originalHead = JSON.stringify(f.ledger.current());
  await expect(runExecutionAgentDecision(f.request, options(f))).resolves.toMatchObject({ decision: { action: "respond" } });
  const sent = assertCountedEnvelopes(f);
  expect(sent).toHaveLength(2);
  const first = sent[0]!.messages as ChatMessage[], repair = sent[1]!.messages as ChatMessage[];
  assertClock(first, "2026-11-22 08:00:01");
  assertClock(repair, "2026-11-22 08:01:02");
  expect(repair.slice(0, first.length - 1)).toEqual(first.slice(0, -1));
  expect(repair).toHaveLength(first.length + 1);
  expect(repair.at(-2)).toMatchObject({ role: "system", content: expect.stringContaining("Repair attempt: 1.") });
  expect(JSON.stringify(repair)).not.toContain("2026-11-22 08:00:01");
  const payloads = sent.map((input) => buildOpenAIResponsesPayload(input));
  const firstInput = payloads[0]!.input as unknown[];
  expect((payloads[1]!.input as unknown[]).slice(0, firstInput.length - 1)).toEqual(firstInput.slice(0, -1));
  expect(payloads[1]!.tools).toEqual(payloads[0]!.tools);
  expect(payloads[1]!.prompt_cache_key).toBe(payloads[0]!.prompt_cache_key);
  expect(sent[1]!.promptCacheBoundaryBeforeMessageIndex).toBe(sent[0]!.promptCacheBoundaryBeforeMessageIndex);
  expect(JSON.stringify(f.ledger.current())).toBe(originalHead);
  expect(f.request.temporalContext).toEqual(requestTime);
});

test.each(["openai", "openai-chatgpt", "llamacpp"] as const)(
  "EA with %s outside the cache opt-in keeps its existing temporal context", async (provider) => {
    const policy: ModelGatewayPolicyConfig = { ...executionPrefixCachePolicy,
      providers: { fixture: { type: provider } },
      profiles: { test: { provider: "fixture", model: "test", contextWindowTokens: 32000,
        ...(provider === "openai" ? {} : { options: { prompt_cache_options: { mode: "implicit" } } }) } },
    };
    const f = await fixture(policy);
    f.invoke.mockResolvedValue({ text: JSON.stringify({ decision: { action: "respond" } }), meta: {} });
    f.countInputTokens.mockImplementation(async () => ({ inputTokens: 1000, profileId: "test", provider,
      model: "test", contextWindowTokens: 32000, source: "provider_input_token_count" }));
    await expect(runExecutionAgentDecision(f.request, options(f))).resolves.toMatchObject({ decision: { action: "respond" } });
    expect(f.invoke).toHaveBeenCalledOnce();
    const sent = f.invoke.mock.calls[0]![0].messages as ChatMessage[];
    expect(capsules(sent, invocationKind)).toEqual([]);
    expect(capsules(sent, requestKind)).toHaveLength(1);
    expect(f.countInputTokens.mock.calls[0]![0].messages).toEqual(sent);
    expect(f.request.temporalContext).toEqual(requestTime);
  },
);
