import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import { createSemanticCompactionSha256Fingerprint as hash, type SemanticCompactionCandidate } from "../context/semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../context/semantic-compaction/generation-contracts.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { prepareSuperCheckpointBudget } from "../context/super-compaction/checkpoint-budget.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { buildCheckpointMessage } from "../context/semantic-compaction/checkpoint-message.js";
import { projectSuperContinuation } from "../context/super-compaction/continuation-projection.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("an above-target raw source is still model-compressed even when its checkpoint would fit", async () => {
  const f = fixture();
  const raw = source("raw-0", "RAW_EVIDENCE ".repeat(250));
  const params = { ...f.params, sources: [raw] };
  const { sourceCharacterLimits, budget } = await prepareSuperCheckpointBudget(params, [raw]);
  expect(raw.content.length).toBeGreaterThan(sourceCharacterLimits[0]!);
  const hypothetical = checkpoint(params, raw, `Retained source (verbatim):\n${raw.content}\nEnd of retained source.`);
  expect(checkpointTokens(hypothetical)).toBeLessThan(budget.checkpointTokenAllowance);
  const candidate = await generateSuperCompactionCandidate(params);
  expect(f.calls.map(({ step }) => step)).toEqual([
    "super.compact.coverage", "super.compact.content", "super.compact.continuation",
  ]);
  expect(candidate.sourceDigests[0]!.digest).not.toContain(raw.content);
  expect(f.request.contextCompactionStore!.materializeSource(raw.sourceRef, raw.sourceFingerprint)).toEqual(raw);
  expect(f.request.contextCompactionStore!.get(params.scopeId)).toBeUndefined();
});

test("a restored above-target digest is reused when the mixed checkpoint fits", async () => {
  const f = fixture();
  const raw = source("previous-0", "CANONICAL_EVIDENCE ".repeat(180));
  const previous = checkpoint(f.params, raw, "EXISTING_MODEL_SUMMARY ".repeat(150).trim());
  const store = f.request.contextCompactionStore!;
  store.registerSources([raw]);
  store.commit(previous);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(captureRequestContextCompaction(store))));
  const request = deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restored });
  const fresh = source("fresh-0", "A later partial finding.");
  const params = { ...f.params, request, previous: restored.get(f.params.scopeId)!, sourceRevision: 2, sources: [fresh] };
  const { sourceCharacterLimits, budget } = await prepareSuperCheckpointBudget(params, [raw, fresh]);
  expect(previous.sourceDigests[0]!.digest.length).toBeGreaterThan(sourceCharacterLimits[0]!);
  expect(checkpointTokens(previous)).toBeLessThan(budget.checkpointTokenAllowance);
  const candidate = await generateSuperCompactionCandidate(params);
  expect(f.calls.map(({ step, sourceRef }) => ({ step, sourceRef }))).toEqual([
    { step: "super.compact.continuation", sourceRef: fresh.sourceRef },
  ]);
  expect(candidate.sourceDigests[0]).toEqual(previous.sourceDigests[0]);
  expect(candidate.sourceDigests[1]!.digest).toContain(fresh.content);
  expect(checkpointTokens(candidate)).toBeLessThanOrEqual(budget.checkpointTokenAllowance);
  expect(f.checkpointMeasurements.at(-1)).toBe(checkpointTokens(candidate));
  expect(restored.get(f.params.scopeId)).toEqual(previous);
  expect(restored.materializeSource(raw.sourceRef, raw.sourceFingerprint)).toEqual(raw);
});

test("small raw sources and bounded previous digests retain the existing selection behavior", async () => {
  const f = fixture();
  const small = source("small-0", "One partial observation; verification is pending.");
  const candidate = await generateSuperCompactionCandidate({ ...f.params, sources: [small] });
  expect(f.calls.map(({ step }) => step)).toEqual(["super.compact.continuation"]);
  expect(candidate.sourceDigests[0]!.digest).toBe(`Retained source (verbatim):\n${small.content}\nEnd of retained source.`);
  f.request.contextCompactionStore!.commit(candidate);
  f.calls.length = 0;
  await expect(generateSuperCompactionCandidate({ ...f.params, previous: candidate, sourceRevision: 2, sources: [] }))
    .rejects.toThrow("context_compaction_sources_empty");
  expect(f.calls).toEqual([]);
  const fresh = source("small-1", "A second partial finding.");
  const repeated = await generateSuperCompactionCandidate({ ...f.params, previous: candidate, sourceRevision: 2, sources: [fresh] });
  expect(f.calls.map(({ step, sourceRef }) => ({ step, sourceRef }))).toEqual([
    { step: "super.compact.continuation", sourceRef: fresh.sourceRef },
  ]);
  expect(repeated.sourceDigests[0]).toEqual(candidate.sourceDigests[0]);
});

test("a selected small source keeps the original continuation-overflow failure instead of starting a new fold", async () => {
  const f = fixture();
  const policy = f.request.modelPolicy!;
  const request = deriveTestRequestExecutionScope(f.request, { modelPolicy: {
    ...policy, profiles: { ...policy.profiles,
      narrow: { provider: "test", model: "narrow", contextWindowTokens: 3_000 },
    },
    defaults: { ...policy.defaults, steps: { ...policy.defaults?.steps, "super.compact.continuation": "narrow" } },
  } });
  await expect(generateSuperCompactionCandidate({
    ...f.params, request, sources: [source("small-0", "One partial observation.")],
  })).rejects.toThrow("super_compaction_continuation_input_exceeds_budget");
  expect(f.calls).toEqual([]);
  expect(request.contextCompactionStore!.get(f.params.scopeId)).toBeUndefined();
});

test("repeated measured-window tool cycles skip only intermediate merge calls and keep bounded source summaries", async () => {
  const f = fixture(1);
  let previous: SemanticCompactionCandidate | undefined;
  for (let cycle = 0; cycle < 4; cycle++) {
    const raw = source(`tool-${cycle}`, `RAW_${cycle}:` + "x".repeat(16_384 - 6));
    const start = f.calls.length;
    const candidate = await generateSuperCompactionCandidate({
      ...f.params, previous, sourceRevision: cycle + 1, sources: [raw],
    });
    const calls = f.calls.slice(start);
    const windows = calls.filter(({ step }) => step === "super.compact.coverage");
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(calls.slice(0, windows.length * 2).map(({ step }) => step)).toEqual(
      windows.flatMap(() => ["super.compact.coverage", "super.compact.content"]),
    );
    expect(windows.map(({ sourceContent }) => sourceContent).join("")).toBe(raw.content);
    const merges = calls.filter(({ step }) => step === "super.compact.merge");
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.length).toBeLessThan(windows.length - 1);
    expect(calls.at(-1)!.step).toBe("super.compact.continuation");
    expect(calls.every(({ sourceRef }) => sourceRef === raw.sourceRef)).toBe(true);
    expect(merges.at(-1)!.range).toMatchObject({ startByte: 0, endByteExclusive: 16_384 });
    expect(candidate.sourceDigests.slice(0, cycle)).toEqual(previous?.sourceDigests ?? []);
    expect(candidate.sourceDigests).toHaveLength(cycle + 1);
    for (const digest of candidate.sourceDigests) {
      expect(digest.digest.length).toBeLessThan(400);
      expect(digest.digest).not.toContain("RAW_");
    }
    expect(checkpointTokens(candidate)).toBeLessThanOrEqual(4_800);
    expect(f.checkpointMeasurements.at(-1)).toBe(checkpointTokens(candidate));
    expect(f.request.contextCompactionStore!.get(f.params.scopeId)).toEqual(previous);
    f.request.contextCompactionStore!.commit(candidate);
    previous = candidate;
  }
});

function source(sourceRef: string, content: string) {
  return { sourceRef, content, sourceFingerprint: hash(content) };
}

function checkpoint(params: SemanticCompactionGenerationParams, raw: ReturnType<typeof source>, digest: string): SemanticCompactionCandidate {
  return { ...params.binding, kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: params.scopeId, sourceRevision: params.sourceRevision,
    sourceDigests: [{ sourceRef: raw.sourceRef, sourceFingerprint: raw.sourceFingerprint, digest }],
    continuation: createSuperContinuation("Observed facts remain partial."),
  };
}

function checkpointTokens(candidate: SemanticCompactionCandidate): number {
  return tokens([buildCheckpointMessage(candidate, { projectContinuation: projectSuperContinuation })]);
}

function tokens(messages: readonly ChatMessage[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 4);
}

function fixture(stageBytesPerToken = 4) {
  const calls: Array<{ step: string; sourceRef: string; sourceContent?: string; range: { startByte: number; endByteExclusive: number } }> = [];
  const checkpointMeasurements: number[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const envelope = JSON.parse((input.messages as readonly ChatMessage[]).find(({ role }) => role === "user")!.content);
    const base = envelope.baseCapsule;
    const slice = base.sourceSlice ?? base.source;
    const step = input.modelStep!;
    calls.push({ step, sourceRef: slice.sourceRef, sourceContent: slice.content, range: slice.range });
    const fact = `FACT:${slice.sourceRef}:${slice.range.startByte}.`;
    const text = step === "super.compact.coverage" ? `Partial range ${slice.range.startByte}-${slice.range.endByteExclusive}. ${"coverage ".repeat(20)}`
      : step === "super.compact.content" ? `${fact} ${"observed detail ".repeat(70)}`
      : step === "super.compact.merge" ? (JSON.stringify(base.children).match(/FACT:[\w-]+:\d+\./g) ?? []).join(" ")
      : "Partial observations preserved; verification remains pending.";
    return { text, meta: {} };
  });
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    const isCheckpoint = JSON.parse(messages.find(({ role }) => role === "user")!.content).kind === "runtime_semantic_compaction_checkpoint_v2";
    const count = isCheckpoint ? tokens(messages) : Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / stageBytesPerToken);
    if (isCheckpoint) checkpointMeasurements.push(count);
    const invocation = resolveModelInvocation(input);
    return { inputTokens: count, profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const original = createCompactionRequest({ requestId: "super-source-boundaries", prompt: "Preserve partial observations.", invoke });
  const request = deriveTestRequestExecutionScope(original, {
    ...projectSuperCompactionConfiguration(original, original.executionPolicy.authority),
    modelGatewayClient: { ...original.modelGatewayClient, countInputTokens },
  });
  const params: SemanticCompactionGenerationParams = {
    request, scopeId: "worker:source-boundaries", sourceRevision: 1, sources: [],
    preservationObjective: request.prompt, consumer: "worker.result",
    binding: { requestId: request.requestId, currentRequestFingerprint: hash(request.prompt),
      roleId: "worker", callId: "source-boundaries", objectiveFingerprint: hash(request.prompt),
      contextLane: "role_continuation", allowedConsumers: ["worker.result"] },
  };
  return { params, request, calls, checkpointMeasurements };
}
