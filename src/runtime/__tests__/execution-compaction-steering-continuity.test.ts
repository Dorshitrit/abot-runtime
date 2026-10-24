import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestSessionMemory } from "../context/session-memory/index.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/contracts.js";
import { restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { REQUEST_STEERING_MESSAGE_KIND } from "../request/request-steering.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runtimeCapsule } from "./support/execution-controls-evidence-fixture.js";
import {
  executionCompactionSteeringFixture,
  STEERED_CONTINUATION,
  STEERED_FACT,
  STEERED_RAW,
} from "./support/execution-compaction-steering-fixture.js";
import {
  compactContinuation,
  readCompactionEnvelope,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";

type Fixture = Awaited<ReturnType<typeof executionCompactionSteeringFixture>>;
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test.each([false, true])(
  "consecutive steering retains exact evidence and current user authority without new compaction (response=%s)",
  async (response) => {
    const f = await executionCompactionSteeringFixture();
    await f.run(response);
    const snapshot = f.request.contextCompactionStore!.snapshot!();
    const original = snapshot.checkpoints[0]!;
    // Same-objective reuse still includes its own continuation.
    f.invoke.mockClear();
    await f.run(response);
    expect(JSON.stringify(consumerMessages(f))).toContain(STEERED_CONTINUATION);
    for (const [index, text] of [
      "Compare the verified values.",
      "Stop implementation and report the evidence only.",
    ].entries()) {
      f.steering.append({ steerId: `steer-${index}`, text });
      f.invoke.mockClear();
      await f.run(response);
      expect(compactorCalls(f)).toHaveLength(0);
      assertInheritedEvidence(f, original);
      expect(f.request.contextCompactionStore!.snapshot!()).toEqual(snapshot);
    }
  },
);

test.each([false, true])(
  "inherited evidence admits above the soft trigger through the session-memory owner (response=%s)",
  async (response) => {
    const history: RequestSessionMemory = {
      project: () => ({
        priorConversationMessages: [], historyMessages: [],
        compactableTurnCount: 0, checkpointRevision: 0,
        sourceRevision: "unchanged-empty-history",
      }),
      prepare: vi.fn(async () => { throw new Error("unexpected_history_compaction"); }),
    };
    const f = await executionCompactionSteeringFixture({ sessionMemory: history });
    await f.run(response);
    const snapshot = f.request.contextCompactionStore!.snapshot!();
    f.steering.append({ steerId: "changed", text: "Report only the observed value." });
    f.invoke.mockClear();
    f.countInputTokens.mockClear();
    f.countInputTokens.mockResolvedValue({
      inputTokens: 23_000, profileId: "test", provider: "openai", model: "test",
      contextWindowTokens: 32_000, source: "provider_input_token_count",
    });
    await f.run(response);
    expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
      response ? "execution.response" : "execution.decision",
    ]);
    expect(f.countInputTokens).toHaveBeenCalled();
    expect(history.prepare).not.toHaveBeenCalled();
    expect(f.request.contextCompactionStore!.snapshot!()).toEqual(snapshot);
    assertInheritedEvidence(f, snapshot.checkpoints[0]!);
  },
);

test("restored checkpoints retain their original binding and canonical sources across steering", async () => {
  const initial = await executionCompactionSteeringFixture();
  initial.steering.append({ steerId: "initial", text: "Compare verified values." });
  await initial.run();
  const saved = JSON.parse(JSON.stringify(initial.request.contextCompactionStore!.snapshot!()));
  const restoredStore = restoreRequestContextCompaction(saved);
  const restored = await executionCompactionSteeringFixture({
    contextCompactionStore: restoredStore,
  });
  restored.steering.append({ steerId: "initial", text: "Compare verified values." });
  restored.steering.append({ steerId: "later", text: "Report the observations only." });
  await restored.run();
  expect(compactorCalls(restored)).toHaveLength(0);
  assertInheritedEvidence(restored, saved.checkpoints[0]!);
  expect(restoredStore.snapshot!()).toEqual(saved);
  for (const source of saved.sources) {
    expect(restoredStore.materializeSource(source.sourceRef, source.sourceFingerprint))
      .toEqual(source);
  }
});

test("new evidence compacts with inherited coverage under the new objective without rereading covered raw sources", async () => {
  const f = await executionCompactionSteeringFixture();
  await f.run();
  const store = f.request.contextCompactionStore!;
  const old = store.snapshot!().checkpoints[0]!;
  const originalSources = store.snapshot!().sources;
  f.steering.append({ steerId: "changed", text: "Compare a different attribute." });
  await f.run();
  const freshId = await f.addResult("FRESH_UNCOMPACTED_EVIDENCE_".repeat(600), {
    target: "fresh.txt",
  });
  f.invoke.mockClear();
  await f.run();
  expect(compactorCalls(f)).toHaveLength(1);
  const messages = compactorCalls(f)[0]![0].messages as readonly ChatMessage[];
  const envelope = readCompactionEnvelope(messages);
  expect(envelope.previousSourceDigests).toEqual(old.sourceDigests.map((source) =>
    expect.objectContaining(source),
  ));
  expect(envelope.newSources?.map(({ sourceRef }) => sourceRef))
    .toContain(`tool-result:${freshId}`);
  expect(envelope.newSources?.some(({ sourceRef }) =>
    old.sourceDigests.some((source) => source.sourceRef === sourceRef),
  )).toBe(false);
  expect(JSON.stringify(messages)).not.toContain(STEERED_RAW);
  expect(JSON.stringify(messages)).not.toContain(STEERED_CONTINUATION);
  const checkpoints = store.snapshot!().checkpoints;
  expect(checkpoints).toHaveLength(2);
  expect(checkpoints).toContainEqual(old);
  const next = checkpoints.find(({ scopeId }) => scopeId !== old.scopeId)!;
  expect(next.objectiveFingerprint).not.toBe(old.objectiveFingerprint);
  expect(next.sourceDigests.slice(0, old.sourceDigests.length)).toEqual(old.sourceDigests);
  expect(next.sourceDigests).toContainEqual(expect.objectContaining({
    sourceRef: `tool-result:${freshId}`,
  }));
  for (const source of originalSources) {
    expect(store.materializeSource(source.sourceRef, source.sourceFingerprint)).toEqual(source);
  }
  f.steering.append({ steerId: "again", text: "Summarize both observations." });
  f.invoke.mockClear();
  await f.run();
  expect(compactorCalls(f)).toHaveLength(0);
  assertInheritedEvidence(f, next);
});

test.each([
  { name: "request", changes: { requestId: "foreign-request" } },
  { name: "original prompt", changes: { currentRequestFingerprint: hash("other prompt") } },
  { name: "call", changes: { callId: "foreign-call" } },
  { name: "scope", changes: { scopeId: "role:supervisor:call-1:other" } },
  { name: "objective outside the accepted prefix", changes: { objectiveFingerprint: hash("unaccepted objective") } },
] satisfies readonly { name: string; changes: Partial<SemanticCompactionCheckpoint> }[])(
  "a checkpoint with mismatched $name does not supply inherited evidence",
  async ({ changes }) => {
    const initial = await executionCompactionSteeringFixture();
    await initial.run();
    const snapshot = initial.request.contextCompactionStore!.snapshot!();
    const foreign = {
      ...snapshot.checkpoints[0]!,
      ...changes,
      sourceDigests: snapshot.checkpoints[0]!.sourceDigests.map((source) => ({
        ...source, digest: "FOREIGN_EVIDENCE_MUST_NOT_TRANSFER",
      })),
    };
    const store = restoreRequestContextCompaction({ ...snapshot, checkpoints: [foreign] });
    const f = await executionCompactionSteeringFixture({ contextCompactionStore: store });
    f.steering.append({ steerId: "changed", text: "Report the observations." });
    await f.run();
    expect(compactorCalls(f)).toHaveLength(1);
    const envelope = readCompactionEnvelope(compactorCalls(f)[0]![0].messages as ChatMessage[]);
    expect(envelope.previousSourceDigests ?? []).toEqual([]);
    expect(envelope.newSources?.some(({ content }) => content.includes(STEERED_RAW)))
      .toBe(true);
    expect(JSON.stringify(consumerMessages(f))).not.toContain("FOREIGN_EVIDENCE_MUST_NOT_TRANSFER");
  },
);

test.each(["missing", "changed"] as const)(
  "inherited evidence fails closed when its registered source is %s",
  async (mismatch) => {
    const initial = await executionCompactionSteeringFixture();
    await initial.run();
    const originalStore = initial.request.contextCompactionStore!;
    const saved = originalStore.snapshot!();
    const sourceRef = `tool-result:${initial.executionId}`;
    const store = {
      ...originalStore,
      materializeSource(ref: string, fingerprint: string) {
        const canonical = originalStore.materializeSource(ref, fingerprint);
        if (ref !== sourceRef) return canonical;
        return mismatch === "missing"
          ? undefined
          : { ...canonical!, content: "FOREIGN_RAW_SOURCE" };
      },
    };
    const f = await executionCompactionSteeringFixture({ contextCompactionStore: store });
    f.steering.append({ steerId: "changed", text: "Report the observations." });
    await expect(f.run()).rejects.toThrow(/context_compaction_.*source/);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(originalStore.snapshot!()).toEqual(saved);
  },
);

test("SUPER Worker keeps strict objective binding and its unchanged continuation contract", () => {
  const f = semanticContractFixture({ policy: "supervisor-worker-v1" });
  const checkpoint: SemanticCompactionCheckpoint = {
    ...f.params.binding,
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: f.params.scopeId,
    sourceRevision: f.params.sourceRevision,
    sourceDigests: [{
      sourceRef: f.source.sourceRef,
      sourceFingerprint: f.source.sourceFingerprint,
      digest: STEERED_FACT,
    }],
    continuation: compactContinuation({ currentState: STEERED_CONTINUATION }),
  };
  f.store.registerSources([f.source]);
  f.store.commit(checkpoint);
  const options = {
    call: { roleId: "worker", callId: checkpoint.callId, objective: f.params.preservationObjective },
    sourceRevision: checkpoint.sourceRevision,
    allowedConsumers: checkpoint.allowedConsumers,
    scopeId: checkpoint.scopeId,
  };
  const unchanged = createModelStepCompactionController(f.params.request, options);
  expect(JSON.stringify(unchanged.project([]))).toContain(STEERED_CONTINUATION);
  const changed = createModelStepCompactionController(f.params.request, {
    ...options, call: { ...options.call, objective: "Different delegated assignment." },
  });
  expect(() => changed.project([])).toThrow("context_compaction_checkpoint_not_applicable");
  expect(f.store.get(checkpoint.scopeId)).toEqual(checkpoint);
  expect(f.invoke).not.toHaveBeenCalled();
});

function compactorCalls(f: Fixture) {
  return f.invoke.mock.calls.filter(([input]) => input.modelStep === "context.compact");
}

function consumerMessages(f: Fixture): readonly ChatMessage[] {
  const input = [...f.invoke.mock.calls].reverse().find(
    ([input]) => input.modelStep !== "context.compact",
  )?.[0];
  expect(input).toBeDefined();
  return input!.messages as readonly ChatMessage[];
}

function assertInheritedEvidence(f: Fixture, checkpoint: SemanticCompactionCheckpoint) {
  const messages = consumerMessages(f);
  const serialized = JSON.stringify(messages);
  expect(serialized).not.toContain(STEERED_RAW);
  expect(serialized).not.toContain(STEERED_CONTINUATION);
  const covered = messages.flatMap(({ content }) => {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed.coveredSources) ? parsed.coveredSources : [];
    } catch { return []; }
  });
  expect(covered).toEqual(checkpoint.sourceDigests);
  expect(messages.some(({ role, content }) => role === "user" && content.includes(f.request.prompt)))
    .toBe(true);
  const snapshot = f.steering.snapshot();
  expect(runtimeCapsule(messages, REQUEST_STEERING_MESSAGE_KIND)).toMatchObject({
    authority: "user", version: snapshot.version,
    updates: snapshot.updates.map(({ sequence, text }) => ({ sequence, text })),
  });
}
