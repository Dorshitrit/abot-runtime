import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import { buildCheckpointMessage } from "../context/semantic-compaction/checkpoint-message.js";
import { createSemanticCompactionSha256Fingerprint as hash, type SemanticCompactionCandidate, type SemanticCompactionSource } from "../context/semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../context/semantic-compaction/generation-contracts.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { prepareSuperCheckpointBudget } from "../context/super-compaction/checkpoint-budget.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { projectSuperContinuation } from "../context/super-compaction/continuation-projection.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("retains an above-target old digest when the measured complete checkpoint fits", async () => {
  const f = fixture();
  const old = source("old-0"), fresh = source("fresh-0");
  const previous = seedPrevious(f, [old], [4_000]);
  const params = { ...f.params, previous, sources: [fresh], sourceRevision: 2 };
  const { sourceCharacterLimits } = await prepareSuperCheckpointBudget(params, [old, fresh]);
  expect(previous.sourceDigests[0]!.digest.length).toBeGreaterThan(sourceCharacterLimits[0]!);
  const candidate = await generateSuperCompactionCandidate(params);
  expect(candidate.sourceDigests[0]).toEqual(previous.sourceDigests[0]);
  expect(f.calls.map(({ sourceRef, step }) => [sourceRef, step])).toEqual(freshCalls(fresh));
  expect(finalMeasurements(f)).toHaveLength(1);
  expect(finalMeasurements(f)[0]!.tokens).toBeLessThanOrEqual(4_800);
  expect(candidate.continuation.currentState).toBe(handoff(fresh));
  expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toBe(previous);
});

test("reduces an old canonical source only after actual overflow, without replaying fresh work", async () => {
  const f = fixture();
  const old = source("old-0"), fresh = source("fresh-0");
  const previous = seedPrevious(f, [old], [17_000]);
  const candidate = await generateSuperCompactionCandidate({ ...f.params, previous, sources: [fresh], sourceRevision: 2 });
  expect(checkpointTokens(previous)).toBeLessThanOrEqual(4_800);
  const counts = finalMeasurements(f);
  expect(counts).toHaveLength(2);
  expect(counts[0]!.tokens).toBeGreaterThan(4_800);
  expect(counts[1]!.tokens).toBeLessThanOrEqual(4_800);
  expect(f.calls.map(({ sourceRef, step }) => [sourceRef, step])).toEqual([
    ...freshCalls(fresh), [old.sourceRef, "super.compact.coverage"], [old.sourceRef, "super.compact.content"],
  ]);
  expect(f.calls.filter(({ sourceRef }) => sourceRef === old.sourceRef).map(({ content }) => content)).toEqual([old.content, old.content]);
  expect(f.calls.filter(({ sourceRef }) => sourceRef === old.sourceRef).every(({ previousContinuation }) => !previousContinuation?.includes(handoff(fresh)))).toBe(true);
  expect(candidate.sourceDigests[0]!.digest).not.toBe(previous.sourceDigests[0]!.digest);
  expect(candidate.sourceDigests[1]).toEqual(counts[0]!.digests[1]);
  expect(counts[1]!.continuation).toBe(counts[0]!.continuation);
  expect(candidate.continuation.currentState).toBe(handoff(fresh));
  expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toBe(previous);
  expect(f.request.contextCompactionStore!.materializeSource(old.sourceRef, old.sourceFingerprint)).toEqual(old);
});

test("stops after the first old reduction fits and leaves the other old digest unchanged", async () => {
  const f = fixture();
  const old = [source("old-0"), source("old-1")], fresh = source("fresh-0");
  const previous = seedPrevious(f, old, [8_600, 8_600]);
  const candidate = await generateSuperCompactionCandidate({ ...f.params, previous, sources: [fresh], sourceRevision: 2 });
  const counts = finalMeasurements(f);
  expect(counts).toHaveLength(2);
  expect(counts[0]!.tokens).toBeGreaterThan(4_800);
  expect(counts[1]!.tokens).toBeLessThanOrEqual(4_800);
  expect(candidate.sourceDigests[0]).not.toEqual(previous.sourceDigests[0]);
  expect(candidate.sourceDigests[1]).toEqual(previous.sourceDigests[1]);
  expect(candidate.sourceDigests[2]).toEqual(counts[0]!.digests[2]);
  expect(f.calls.filter(({ sourceRef }) => sourceRef === old[1]!.sourceRef)).toEqual([]);
  expect(f.calls.filter(({ sourceRef }) => sourceRef === fresh.sourceRef).map(({ step }) => step)).toEqual(freshCalls(fresh).map(([, step]) => step));
});

test("uses every consumer's real profile and reduces for the smaller effective allowance", async () => {
  const f = fixture({ unequalConsumers: true });
  const old = source("old-0"), fresh = source("fresh-0");
  const previous = seedPrevious(f, [old], [8_000]);
  const candidate = await generateSuperCompactionCandidate({ ...f.params, previous, sources: [fresh], sourceRevision: 2 });
  const counts = finalMeasurements(f);
  expect(counts.map(({ profileId }) => profileId)).toEqual(["large", "narrow", "large", "narrow"]);
  expect(counts[0]!.tokens).toBeLessThanOrEqual(19_200);
  expect(counts[1]!.tokens).toBeGreaterThan(2_400);
  expect(counts[3]!.tokens).toBeLessThanOrEqual(2_400);
  expect(candidate.sourceDigests[0]).not.toEqual(previous.sourceDigests[0]);
  expect(candidate.continuation.currentState).toBe(handoff(fresh));
});

test("a checkpoint counter error propagates without generating an old replacement", async () => {
  const f = fixture();
  const old = source("old-0"), fresh = source("fresh-0");
  const previous = seedPrevious(f, [old], [17_000]);
  const failure = new Error("checkpoint_counter_unavailable");
  f.hooks.onCheckpoint = () => { throw failure; };
  await expect(generateSuperCompactionCandidate({ ...f.params, previous, sources: [fresh], sourceRevision: 2 })).rejects.toBe(failure);
  expect(f.calls.map(({ sourceRef, step }) => [sourceRef, step])).toEqual(freshCalls(fresh));
  expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toBe(previous);
});

test("cancellation while reducing an old source preserves the previous checkpoint", async () => {
  const f = fixture();
  const old = source("old-0"), fresh = source("fresh-0");
  const previous = seedPrevious(f, [old], [17_000]);
  const reason = new DOMException("Retained digest reduction cancelled.", "AbortError");
  f.hooks.onCall = ({ sourceRef, step }) => {
    if (sourceRef === old.sourceRef && step === "super.compact.content") f.abort.abort(reason);
  };
  await expect(generateSuperCompactionCandidate({ ...f.params, previous, sources: [fresh], sourceRevision: 2 })).rejects.toBe(reason);
  expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toBe(previous);
  expect(f.calls.filter(({ sourceRef }) => sourceRef === fresh.sourceRef).map(({ step }) => step)).toEqual(freshCalls(fresh).map(([, step]) => step));
  expect(finalMeasurements(f)).toHaveLength(1);
});

test("an irreducible final checkpoint fails once without changing the saved checkpoint or handoff", async () => {
  const f = fixture({ freshHandoff: "NEW_HANDOFF:" + "h".repeat(21_000) });
  const old = source("old-0"), fresh = source("fresh-0");
  const previous = seedPrevious(f, [old], [17_000]);
  await expect(generateSuperCompactionCandidate({ ...f.params, previous, sources: [fresh], sourceRevision: 2 }))
    .rejects.toThrow("context_compaction_checkpoint_tokens_exceeded");
  const counts = finalMeasurements(f);
  expect(counts).toHaveLength(2);
  expect(counts.every(({ tokens }) => tokens > 4_800)).toBe(true);
  expect(counts[1]!.continuation).toBe(counts[0]!.continuation);
  expect(counts[1]!.digests[1]).toEqual(counts[0]!.digests[1]);
  expect(f.calls.map(({ sourceRef, step }) => [sourceRef, step])).toEqual([
    ...freshCalls(fresh), [old.sourceRef, "super.compact.coverage"], [old.sourceRef, "super.compact.content"],
  ]);
  expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toBe(previous);
});

test("restored multi-cycle checkpoints keep old summaries and original source identities while they fit", async () => {
  const f = fixture();
  const old = source("old-0");
  let previous = seedPrevious(f, [old], [4_000]);
  let request = f.request;
  for (let cycle = 0; cycle < 3; cycle++) {
    const snapshot = captureRequestContextCompaction(request.contextCompactionStore!);
    const store = restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot)));
    request = deriveTestRequestExecutionScope(request, { contextCompactionStore: store });
    previous = store.get(f.params.scopeId)!;
    const fresh = source(`fresh-${cycle}`);
    const before = f.calls.length;
    const candidate = await generateSuperCompactionCandidate({ ...f.params, request, previous, sources: [fresh], sourceRevision: cycle + 2 });
    expect(candidate.sourceDigests.slice(0, -1)).toEqual(previous.sourceDigests);
    expect(f.calls.slice(before).map(({ sourceRef, step }) => [sourceRef, step])).toEqual(freshCalls(fresh));
    expect(candidate.continuation.currentState).toBe(handoff(fresh));
    expect(store.get(f.params.scopeId)).toBe(previous);
    expect(store.materializeSource(old.sourceRef, old.sourceFingerprint)).toEqual(old);
    store.commit(candidate);
    expect(captureRequestContextCompaction(restoreRequestContextCompaction(store.snapshot!()))).toEqual(store.snapshot!());
  }
});

type Call = { step: string; sourceRef: string; content?: string; previousContinuation?: string };
type Measurement = { profileId: string; tokens: number; digests: SemanticCompactionCandidate["sourceDigests"]; continuation: string };
type Hooks = { onCheckpoint?: (measurement: Measurement) => void; onCall?: (call: Call) => void };

function fixture(options: { unequalConsumers?: boolean; freshHandoff?: string } = {}) {
  const calls: Call[] = [], measurements: Measurement[] = [], hooks: Hooks = {};
  const abort = new AbortController();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const envelope = userEnvelope(input.messages as readonly ChatMessage[]);
    const base = envelope.baseCapsule;
    const slice = base.sourceSlice ?? base.source;
    const call = { step: input.modelStep!, sourceRef: slice.sourceRef, content: slice.content,
      previousContinuation: base.previousContinuation?.content };
    calls.push(call);
    hooks.onCall?.(call);
    const text = call.step === "super.compact.coverage" ? `Coverage:${call.sourceRef}:supplied range.`
      : call.step === "super.compact.content" ? `FACT:${call.sourceRef}:${"bounded evidence ".repeat(45)}`
      : call.step === "super.compact.continuation" ? options.freshHandoff ?? handoff(slice)
      : `MERGED:${call.sourceRef}:bounded evidence.`;
    return { text, meta: {} };
  });
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    const envelope = userEnvelope(messages);
    const invocation = resolveModelInvocation(input);
    const tokens = serializedTokens(messages, invocation.profile.id === "narrow" ? 2 : 4);
    if (envelope.kind === "runtime_semantic_compaction_checkpoint_v2") {
      const measurement = { profileId: invocation.profile.id, tokens, digests: envelope.coveredSources,
        continuation: envelope.continuation.text };
      measurements.push(measurement);
      if (measurement.digests.some(({ digest }: { digest: string }) => digest.length > 0)) hooks.onCheckpoint?.(measurement);
    }
    return { inputTokens: tokens, profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const original = createCompactionRequest({ requestId: "super-retained-digests", prompt: "Preserve settled evidence and unresolved work.", invoke });
  const policy = original.modelPolicy!;
  const request = deriveTestRequestExecutionScope(original, {
    ...projectSuperCompactionConfiguration(original, original.executionPolicy.authority),
    abortSignal: abort.signal,
    modelGatewayClient: { ...original.modelGatewayClient, countInputTokens },
    ...(options.unequalConsumers ? { modelPolicy: {
      ...policy, profiles: { ...policy.profiles,
        large: { provider: "test", model: "large-model", contextWindowTokens: 64_000 },
        narrow: { provider: "test", model: "narrow-model", contextWindowTokens: 8_000 },
      }, defaults: { ...policy.defaults, steps: { ...policy.defaults?.steps,
        "worker.result": "large", "reviewer.decision": "narrow",
      } },
    } } : {}),
  });
  const params: SemanticCompactionGenerationParams = {
    request, scopeId: "worker:retained-digests", sourceRevision: 1, sources: [],
    preservationObjective: request.prompt, consumer: "worker.result",
    binding: { requestId: request.requestId, currentRequestFingerprint: hash(request.prompt),
      roleId: "worker", callId: "retained-digests", objectiveFingerprint: hash(request.prompt),
      contextLane: "role_continuation", allowedConsumers: options.unequalConsumers ? ["worker.result", "reviewer.decision"] : ["worker.result"] },
  };
  return { params, request, calls, measurements, hooks, abort };
}

function source(sourceRef: string): SemanticCompactionSource {
  const content = `CANONICAL:${sourceRef}:original evidence.`.padEnd(6_000, "e");
  return { sourceRef, content, sourceFingerprint: hash(content) };
}

function seedPrevious(f: ReturnType<typeof fixture>, sources: readonly SemanticCompactionSource[], lengths: readonly number[]): SemanticCompactionCandidate {
  const previous: SemanticCompactionCandidate = {
    ...f.params.binding, kind: "runtime_semantic_compaction_checkpoint_v2", scopeId: f.params.scopeId,
    sourceRevision: 1, continuation: createSuperContinuation("PRIOR_HANDOFF:earlier observations remain partial."),
    sourceDigests: sources.map(({ sourceRef, sourceFingerprint }, index) => ({ sourceRef, sourceFingerprint,
      digest: `OLD_DIGEST:${sourceRef}:`.padEnd(lengths[index]!, "d") })),
  };
  f.request.contextCompactionStore!.registerSources(sources);
  f.request.contextCompactionStore!.commit(previous);
  return f.request.contextCompactionStore!.get(f.params.scopeId)!;
}

function handoff(source: Pick<SemanticCompactionSource, "sourceRef">) { return `NEW_HANDOFF:${source.sourceRef}:latest result preserved; next work remains open.`; }
function freshCalls(source: SemanticCompactionSource) { return ["super.compact.coverage", "super.compact.content", "super.compact.continuation"].map((step) => [source.sourceRef, step]); }
function finalMeasurements(f: ReturnType<typeof fixture>) { return f.measurements.filter(({ digests }) => digests.some(({ digest }) => digest.length > 0)); }
function userEnvelope(messages: readonly ChatMessage[]) { return JSON.parse(messages.find(({ role }) => role === "user")!.content); }
function serializedTokens(messages: readonly ChatMessage[], bytesPerToken = 4) { return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / bytesPerToken); }
function checkpointTokens(candidate: SemanticCompactionCandidate) { return serializedTokens([buildCheckpointMessage(candidate, { projectContinuation: projectSuperContinuation })]); }
