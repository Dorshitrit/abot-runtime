import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import { ProviderContextOverflowError } from "../../model-gateway/protocol/provider-context-overflow.js";
import { ProviderStreamDisconnectionError } from "../../model-gateway/protocol/provider-stream-disconnection.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { buildRequestTemporalContextMessage } from "../context/request-temporal-context.js";
import { invokeStructuredModelStep } from "../model/invoke-structured-step.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { snapshotRequestSeed } from "../request/approval-wait/snapshot.js";
import {
  createAdmissionController, createAdmissionFixture, createAdmissionStage,
} from "./support/compaction-admission-fixture.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => {
  configureDebugLogger({ enabled: false });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); resetDebugLoggerConfig(); });

const temporalContext = Object.freeze({
  currentDateTime: "2026-11-22 09:00:00 GMT+02:00", timeZone: "Asia/Jerusalem",
});
const requestAnchor = buildRequestTemporalContextMessage(temporalContext);
const baseMessages: ChatMessage[] = [
  { role: "system", content: "Use the original request time for relative instructions." },
  requestAnchor,
  { role: "user", content: "Continue the original request." },
];
const tailKind = "fixture_invocation_time";

function createTailFactory() {
  return vi.fn((): readonly ChatMessage[] => Object.freeze([Object.freeze({
    role: "system" as const,
    content: JSON.stringify({ kind: tailKind, observedAt: new Date().toISOString() }),
  })]));
}

function readMessages(input: { messages?: unknown }): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

function tails(messages: readonly ChatMessage[]) {
  return messages.filter(({ content }) => content.includes(`"kind":"${tailKind}"`));
}

test("optional omission measures and sends the same mandatory tail without mutating its source", async () => {
  const f = createAdmissionFixture({ modelStep: "execution.decision", counts: [40_000, 1_000] });
  const optional: ChatMessage = { role: "user", content: "Optional source listing." };
  const messages = [...baseMessages, optional];
  const before = structuredClone(messages);
  const createInvocationTailMessages = createTailFactory();
  const optionalContextProjection = vi.fn((candidate: readonly ChatMessage[]) => {
    expect(tails(candidate)).toEqual([]);
    vi.setSystemTime(new Date("2026-11-22T10:01:00Z"));
    return candidate.filter((message) => message !== optional);
  });

  await expect(f.invoker.invoke({
    modelStep: "execution.decision", messages, createInvocationTailMessages,
    contextRetention: "exact", optionalContextProjection,
    promptCacheBoundaryBeforeMessage: requestAnchor,
    timeoutReason: "tail_timeout", accept: (text) => text,
  })).resolves.toBe("ok");

  expect(createInvocationTailMessages).toHaveBeenCalledOnce();
  expect(optionalContextProjection).toHaveBeenCalledOnce();
  const tail = createInvocationTailMessages.mock.results[0]!.value![0]!;
  const counted = f.countInputTokens.mock.calls.map(([input]) => readMessages(input));
  expect(counted).toEqual([[...messages, tail], [...baseMessages, tail]]);
  const sent = f.invoke.mock.calls[0]![0];
  expect(readMessages(sent)).toEqual(counted[1]);
  expect(sent.promptCacheBoundaryBeforeMessageIndex).toBe(1);
  expect(f.countInputTokens.mock.calls.map(([input]) => input.promptCacheBoundaryBeforeMessageIndex)).toEqual([1, 1]);
  expect(tail.content).toContain("2026-11-22T10:00:00.000Z");
  expect(messages).toEqual(before);
});

test.each([false, true])("compaction retains the counted tail outside sources and committed state (provider recovery=%s)", async (recovery) => {
  const f = createAdmissionFixture({
    modelStep: "execution.decision", counts: [recovery ? 10_000 : 28_000, 6_000],
  });
  const source: ChatMessage[] = [...baseMessages,
    { role: "assistant", content: "", toolCalls: [{ callId: "read-1", name: "read", arguments: "{}" }] },
    { role: "tool", toolCallId: "read-1", toolName: "read", content: "Exact observed evidence. ".repeat(100) },
  ];
  const compacted: ChatMessage[] = [...baseMessages, { role: "system", content: "Bound summary of observed evidence." }];
  const committed: ChatMessage[][] = [];
  const commit = vi.fn(() => { committed.push(structuredClone(compacted)); });
  const stage = createAdmissionStage("active_request", "summary", commit);
  stage.prepare.mockImplementation(async (candidate) => {
    expect(candidate).toEqual(source);
    expect(tails(candidate)).toEqual([]);
    vi.setSystemTime(new Date("2026-11-22T10:02:00Z"));
    return { kind: "prepared", preparation: {
      messages: compacted, scopeId: stage.scopeId, sourceRevision: 1,
      coveredSourceCount: 1, hasExhaustedCompactionSources: true, commit,
    } };
  });
  const controller = createAdmissionController([stage]);
  const createInvocationTailMessages = createTailFactory();
  if (recovery) f.invoke.mockRejectedValueOnce(new ModelGatewayInvocationError("http", "context overflow", {
    cause: new ProviderContextOverflowError(),
  }));

  await expect(f.invoker.invoke({
    modelStep: "execution.decision", messages: source, contextCompaction: controller,
    createInvocationTailMessages, timeoutReason: "tail_timeout", accept: (text) => text,
  })).resolves.toBe("ok");

  expect(createInvocationTailMessages).toHaveBeenCalledOnce();
  expect(stage.prepare).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledOnce();
  expect(controller.project.mock.calls[0]![0]).toEqual(source);
  const tail = createInvocationTailMessages.mock.results[0]!.value![0]!;
  const counted = f.countInputTokens.mock.calls.map(([input]) => readMessages(input));
  expect(counted).toEqual([[...source, tail], [...compacted, tail]]);
  const sent = f.invoke.mock.calls.map(([input]) => readMessages(input));
  expect(sent).toEqual(recovery ? counted : [counted[1]]);
  for (const messages of sent) {
    expect(messages.at(-1)).toBe(tail);
    expect(messages).toContain(requestAnchor);
    expect(tails(messages)).toHaveLength(1);
  }
  expect(tail.content).toContain("2026-11-22T10:00:00.000Z");
  expect(committed).toEqual([compacted]);
  expect(tails(source)).toEqual([]);
  expect(tails(compacted)).toEqual([]);
  expect(tails(committed[0]!)).toEqual([]);
});

test("stream retry reuses the exact measured envelope and creates no second tail", async () => {
  const f = createAdmissionFixture({ modelStep: "execution.decision", counts: [1_000] });
  const createInvocationTailMessages = createTailFactory();
  f.invoke.mockRejectedValueOnce(new ModelGatewayInvocationError("stream", "provider stream ended", {
    cause: new ProviderStreamDisconnectionError(),
  }));
  const result = f.invoker.invoke({
    modelStep: "execution.decision", messages: baseMessages, createInvocationTailMessages,
    timeoutReason: "tail_timeout", accept: (text) => text,
  });
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toBe("ok");

  expect(createInvocationTailMessages).toHaveBeenCalledOnce();
  expect(f.countInputTokens).toHaveBeenCalledOnce();
  expect(f.invoke).toHaveBeenCalledTimes(2);
  const first = f.invoke.mock.calls[0]![0];
  const second = f.invoke.mock.calls[1]![0];
  expect(second.messages).toBe(first.messages);
  expect(readMessages(first)).toEqual(readMessages(f.countInputTokens.mock.calls[0]![0]));
  expect(tails(readMessages(second))).toHaveLength(1);
  expect(second.abortSignal).toBe(first.abortSignal);
});

test("structured repairs refresh only the tail and keep the request anchor across seed restoration", async () => {
  const f = await createControlsEvidenceFixture({ temporalContext });
  const seedBefore = snapshotRequestSeed(f.request);
  const createInvocationTailMessages = createTailFactory();
  const outputs = ["invalid", '{"decision":"unavailable"}', '{"decision":"accepted"}'];
  f.invoke.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 60_000);
    return { text: outputs.shift()!, meta: {} };
  });
  await expect(invokeStructuredModelStep({
    request: f.request, modelStep: "execution.decision", messages: baseMessages,
    promptCacheBoundaryBeforeMessage: requestAnchor, createInvocationTailMessages,
    contextRetention: "exact", timeoutReason: "tail_timeout", invalidOutputReason: "tail_invalid",
    format: { type: "json_schema", name: "tail_fixture", schema: {
      type: "object", additionalProperties: false, required: ["decision"],
      properties: { decision: { type: "string", enum: ["accepted", "unavailable"] } },
    } },
    parse: (text) => text === '{"decision":"accepted"}'
      ? { ok: true, decision: "accepted" }
      : { ok: false, stage: "domain_parser", issues: [
        { code: "unavailable", path: "decision", message: "Choose the available decision." },
      ] },
  })).resolves.toBe("accepted");

  expect(createInvocationTailMessages).toHaveBeenCalledTimes(3);
  const sent = f.invoke.mock.calls.map(([input]) => readMessages(input));
  expect(f.countInputTokens.mock.calls.map(([input]) => readMessages(input))).toEqual(sent);
  expect(sent.map((messages) => JSON.parse(messages.at(-1)!.content).observedAt)).toEqual([
    "2026-11-22T10:00:00.000Z", "2026-11-22T10:01:00.000Z", "2026-11-22T10:02:00.000Z",
  ]);
  for (const messages of sent) {
    expect(tails(messages)).toHaveLength(1);
    expect(messages.slice(0, baseMessages.length)).toEqual(baseMessages);
    expect(messages).toContain(requestAnchor);
  }
  expect(sent[1]).toHaveLength(baseMessages.length + 2);
  expect(sent[2]).toHaveLength(baseMessages.length + 2);
  expect(tails(baseMessages)).toEqual([]);
  const seedAfter = snapshotRequestSeed(f.request);
  expect(seedAfter).toEqual(seedBefore);
  expect(JSON.stringify(seedAfter)).not.toContain(tailKind);
  const restored = deriveTestRequestExecutionScope(f.request, JSON.parse(JSON.stringify(seedAfter)));
  expect(restored.temporalContext).toEqual(temporalContext);
  expect(snapshotRequestSeed(restored)).toEqual(seedBefore);
});
