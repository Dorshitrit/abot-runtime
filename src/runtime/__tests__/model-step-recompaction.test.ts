import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { resolveModelStepCompactionGenerationSources } from "../context/model-step-recompaction-sources.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  generateSemanticCompactionCandidateBatched,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionGenerationParams,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import type { ContextCompactionProjectionRepair } from "../model/context-compaction-contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { compactContinuation, readCompactionEnvelope, semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const REPAIR: ContextCompactionProjectionRepair = Object.freeze({
  reason: "provider_context_overflow",
  originalInputTokens: 24_000,
  candidateInputTokens: 24_000,
  targetInputTokens: 18_000,
});

function toolSource(id: string, content: string) {
  const message = {
    role: "tool", toolCallId: id, toolName: "runtime_capability", content,
  } satisfies ChatMessage;
  const bytes = JSON.stringify(message);
  const source: SemanticCompactionSource = {
    sourceRef: `tool-result:${id}`, sourceFingerprint: hash(bytes), content: bytes,
  };
  return { message, source };
}

function fixture(inherited = false, includeFresh = false) {
  const f = semanticContractFixture({ policy: "execution-agent-v1" });
  const originalSources = [
    toolSource("first", "Canonical original: artifact=report.txt; observed=failed."),
    toolSource("second", "Canonical original: expected=ready; next=verify exact artifact."),
  ];
  const fresh = toolSource("fresh", "Canonical new evidence: verified version=7.");
  const scopeId = "role:supervisor:call-1:continuation";
  const previousScopeId = inherited ? `${scopeId}:predecessor` : scopeId;
  const objective = inherited ? "Verify version 7 using the existing evidence." : f.params.request.prompt;
  const binding = {
    ...f.params.binding, roleId: "supervisor", callId: "call-1",
    objectiveFingerprint: hash(objective),
  };
  f.store.registerSources(originalSources.map(({ source }) => source));
  f.store.commit({
    ...binding,
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: previousScopeId,
    objectiveFingerprint: hash(f.params.request.prompt),
    sourceRevision: 7,
    sourceDigests: originalSources.map(({ source }) => ({
      sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint,
      digest: "Earlier derived summary. ".repeat(30).trim(),
    })),
    continuation: compactContinuation({ currentState: "Earlier derived continuation." }),
  });
  const previous = f.store.get(previousScopeId)!;
  const generated: SemanticCompactionCheckpoint[] = [];
  const generate = vi.fn(async (params: SemanticCompactionGenerationParams) => {
    f.store.registerSources(params.sources);
    const candidate: SemanticCompactionCheckpoint = {
      ...params.binding,
      kind: "runtime_semantic_compaction_checkpoint_v2",
      scopeId: params.scopeId, sourceRevision: params.sourceRevision,
      sourceDigests: params.sources.map(({ sourceRef, sourceFingerprint }) => ({
        sourceRef, sourceFingerprint, digest: `Verified ${sourceRef}.`,
      })),
      continuation: compactContinuation({ currentState: "Verify report.txt against canonical results." }),
    };
    generated.push(candidate);
    return candidate;
  });
  const controller = createModelStepCompactionController(f.params.request, {
    call: { roleId: binding.roleId, callId: binding.callId, objective },
    sourceRevision: 7,
    scopeId,
    allowedConsumers: binding.allowedConsumers,
    consumer: "execution.decision",
    supportsProjectionRepair: true,
    ...(inherited ? { inheritedCheckpoint: previous } : {}),
  }, generate);
  const messages: ChatMessage[] = [
    { role: "system", content: "Current system policy." },
    { role: "user", content: f.params.request.prompt },
    ...(includeFresh ? [fresh.message] : []),
    ...originalSources.map(({ message }) => message),
  ];
  const projected = controller.project(messages);
  return {
    ...f, controller, generate, generated, projected, originalSources,
    fresh, scopeId, previousScopeId, previous, objective,
  };
}

test.each([false, true])(
  "recompaction regenerates original evidence and commits only the admitted candidate (inherited=%s)",
  async (inherited) => {
    const f = fixture(inherited);
    const stage = f.controller.getStages()[0]!;
    const before = captureRequestContextCompaction(f.store);
    expect(await stage.prepare(f.projected)).toEqual({ kind: "unavailable", reason: "no_new_sources" });
    expect(await stage.prepare(f.projected, { projectionRepair: REPAIR }))
      .toEqual({ kind: "unavailable", reason: "no_new_sources" });
    expect(f.generate).not.toHaveBeenCalled();

    const outcome = await stage.prepare(f.projected, {
      projectionRepair: REPAIR, recompactFromSources: true,
    });
    if (outcome.kind !== "prepared") throw new Error("recompaction_candidate_missing");
    const params = f.generate.mock.calls[0]![0];
    expect(params.sources).toEqual(f.originalSources.map(({ source }) => source));
    expect(params.previous).toBeUndefined();
    expect(params.inheritedSourceDigests).toBeUndefined();
    expect(params.projectionRepair).toBe(REPAIR);
    expect(params.request).toBe(f.params.request);
    expect(params.preservationObjective).toBe(f.objective);
    expect(params.binding.objectiveFingerprint).toBe(hash(f.objective));
    expect(params.sourceRevision).toBe(f.previous.sourceRevision);
    expect(JSON.stringify(params.sources)).not.toContain("Earlier derived");
    expect(captureRequestContextCompaction(f.store)).toEqual(before);
    expect(outcome.preparation.coveredSourceCount).toBe(2);
    expect(outcome.preparation.sourceRevision).toBe(7);
    expect(outcome.preparation.hasExhaustedCompactionSources).toBe(true);
    expect(outcome.preparation.messages.filter(({ role }) => role === "tool")).toHaveLength(0);
    expect(outcome.preparation.messages.filter(({ content }) => content === f.params.request.prompt)).toHaveLength(1);
    expect(outcome.preparation.messages[0]).toEqual(f.projected[0]);

    await outcome.preparation.commit();
    const replacement = f.store.get(f.scopeId)!;
    expect(replacement).toEqual(f.generated[0]);
    expect(replacement.sourceDigests.map(({ sourceRef, sourceFingerprint }) => ({ sourceRef, sourceFingerprint })))
      .toEqual(f.previous.sourceDigests.map(({ sourceRef, sourceFingerprint }) => ({ sourceRef, sourceFingerprint })));
    if (inherited) expect(f.store.get(f.previousScopeId)).toBe(f.previous);
    const snapshot = captureRequestContextCompaction(f.store);
    expect(snapshot.sources).toEqual(before.sources);
    expect(JSON.stringify(snapshot)).not.toContain("recompactFromSources");
    expect(captureRequestContextCompaction(restoreRequestContextCompaction(snapshot))).toEqual(snapshot);
    expect(f.invoke).not.toHaveBeenCalled();
  },
);

test("replacement preserves previous source order before newly discovered evidence", async () => {
  const f = fixture(false, true);
  const outcome = await f.controller.getStages()[0]!.prepare(f.projected, {
    projectionRepair: REPAIR, recompactFromSources: true,
  });
  if (outcome.kind !== "prepared") throw new Error("recompaction_candidate_missing");
  expect(f.generate.mock.calls[0]![0].sources).toEqual([
    ...f.originalSources.map(({ source }) => source), f.fresh.source,
  ]);
  expect(f.store.get(f.scopeId)).toBe(f.previous);
  await outcome.preparation.commit();
  expect(f.store.get(f.scopeId)!.sourceDigests.map(({ sourceRef }) => sourceRef)).toEqual([
    ...f.originalSources.map(({ source }) => source.sourceRef), f.fresh.source.sourceRef,
  ]);
});

test("canonical replacement passes the existing generator and exact source-slot validation", async () => {
  const f = fixture();
  await f.controller.getStages()[0]!.prepare(f.projected, {
    projectionRepair: REPAIR, recompactFromSources: true,
  });
  const candidate = await generateSemanticCompactionCandidateBatched(f.generate.mock.calls[0]![0]);
  expect(candidate.sourceDigests.map(({ sourceRef, sourceFingerprint }) => ({ sourceRef, sourceFingerprint })))
    .toEqual(f.previous.sourceDigests.map(({ sourceRef, sourceFingerprint }) => ({ sourceRef, sourceFingerprint })));
  const envelope = readCompactionEnvelope(f.captured[0]!);
  expect(envelope.newSources?.map(({ sourceRef, content }) => ({ sourceRef, content })))
    .toEqual(f.originalSources.map(({ source }) => ({ sourceRef: source.sourceRef, content: source.content })));
  expect(envelope.previousContinuation).toBeUndefined();
  expect(envelope.previousSourceDigests).toBeUndefined();
  expect(f.store.get(f.scopeId)).toBe(f.previous);
});

test.each(["missing", "changed-content", "changed-ref", "changed-fingerprint"] as const)(
  "replacement rejects %s original before changing the store",
  (mode) => {
    const f = fixture();
    const before = captureRequestContextCompaction(f.store);
    const original = f.originalSources[0]!.source;
    const altered = {
      ...original,
      ...(mode === "changed-content" ? { content: "Unverified source bytes" } : {}),
      ...(mode === "changed-ref" ? { sourceRef: "tool-result:unrelated" } : {}),
      ...(mode === "changed-fingerprint" ? { sourceFingerprint: hash("different") } : {}),
    };
    const store = {
      ...f.store,
      materializeSource: () => mode === "missing" ? undefined : altered,
    };
    expect(() => resolveModelStepCompactionGenerationSources({
      store, previous: f.previous, newSources: [], recompactFromSources: true,
    })).toThrow(mode === "missing"
      ? "context_compaction_replacement_source_missing"
      : "context_compaction_source_identity_conflict");
    expect(captureRequestContextCompaction(f.store)).toEqual(before);
    expect(f.generate).not.toHaveBeenCalled();
  },
);

test("replacement carries the original attempt cancellation to compaction invocation", async () => {
  const f = fixture();
  const abort = new AbortController();
  await f.controller.getStages()[0]!.prepare(f.projected, {
    projectionRepair: REPAIR, recompactFromSources: true, abortSignal: abort.signal,
  });
  const request = f.generate.mock.calls[0]![0].request;
  const cause = new Error("original_attempt_deadline");
  abort.abort(cause);
  expect(request.abortSignal.aborted).toBe(true);
  expect(request.abortSignal.reason).toBe(cause);
  expect(f.params.request.abortSignal.aborted).toBe(false);
  expect(f.store.get(f.scopeId)).toBe(f.previous);
});

test("expired recovery does not invoke compaction or replace the checkpoint", async () => {
  const f = fixture();
  const abort = new AbortController();
  const cause = new Error("original_attempt_deadline");
  abort.abort(cause);
  await expect(f.controller.getStages()[0]!.prepare(f.projected, {
    projectionRepair: REPAIR, recompactFromSources: true, abortSignal: abort.signal,
  })).rejects.toBe(cause);
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.store.get(f.scopeId)).toBe(f.previous);
});
