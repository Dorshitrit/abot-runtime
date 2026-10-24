import { expect, test } from "vitest";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import {
  executionCompactionScopeId,
  projectExecutionCompactionObjective,
} from "../context/execution-compaction-objective.js";
import { resolveExecutionEvidenceCheckpoint } from "../context/execution-compaction-checkpoint-selection.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/contracts.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import {
  compactedSourceFixture,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";

const updates = [
  { text: "Use a compact layout." },
  { text: "Keep keyboard access." },
];

function fixture() {
  const f = compactedSourceFixture([settledSource("a"), settledSource("b")]);
  function commit(
    prefix: number,
    overrides: Partial<SemanticCompactionCheckpoint> = {},
  ) {
    const objective = projectExecutionCompactionObjective(
      f.resolver.prompt,
      updates.slice(0, prefix),
    );
    const checkpoint = {
      ...f.checkpoint,
      scopeId: executionCompactionScopeId({ ...f.resolver, objective }),
      objectiveFingerprint: hash(objective),
      ...overrides,
    };
    f.store.commit(checkpoint);
    return f.store.get(checkpoint.scopeId)!;
  }
  function selection(prefix = updates.length) {
    const accepted = updates.slice(0, prefix);
    return {
      ...f.resolver,
      updates: accepted,
      objective: projectExecutionCompactionObjective(
        f.resolver.prompt,
        accepted,
      ),
      sourceRevision: 20,
    };
  }
  return { ...f, commit, selection };
}

test("inherits only canonical accepted prefixes, independent of store insertion order", () => {
  const f = fixture();
  const latest = f.commit(2, { sourceRevision: 8 });
  f.commit(1, { sourceRevision: 12 });
  const before = captureRequestContextCompaction(f.store);
  expect(resolveExecutionEvidenceCheckpoint(f.selection())).toBe(latest);
  expect(Object.isFrozen(latest)).toBe(true);
  expect(captureRequestContextCompaction(f.store)).toEqual(before);
  expect(latest.objectiveFingerprint).toBe(hash(f.selection().objective));
});

test("inherits source evidence from an earlier objective without rebinding its continuation", () => {
  const f = fixture();
  const previous = f.commit(1);
  const selected = resolveExecutionEvidenceCheckpoint(f.selection());
  expect(selected).toBe(previous);
  expect(selected?.objectiveFingerprint).not.toBe(
    hash(f.selection().objective),
  );
  expect(selected?.continuation).toBe(previous.continuation);
  expect(
    f.store.get(executionCompactionScopeId(f.selection())),
  ).toBeUndefined();
});

test("frozen accepted steering excludes a later checkpoint even when it has more evidence", () => {
  const f = fixture();
  const accepted = f.commit(1, {
    sourceDigests: [f.checkpoint.sourceDigests[0]!],
  });
  f.commit(2, { sourceRevision: 15 });
  expect(resolveExecutionEvidenceCheckpoint(f.selection(1))).toBe(accepted);
  expect(resolveExecutionEvidenceCheckpoint(f.selection(0))).toBe(
    f.store.get(f.checkpoint.scopeId),
  );
});

test("source revision bounds reject future evidence and select the earlier eligible prefix", () => {
  const f = fixture();
  const previous = f.commit(1, { sourceRevision: 8 });
  f.commit(2, { sourceRevision: 12 });
  expect(
    resolveExecutionEvidenceCheckpoint({
      ...f.selection(),
      sourceRevision: 10,
    }),
  ).toBe(previous);
  expect(
    resolveExecutionEvidenceCheckpoint({
      ...f.selection(),
      sourceRevision: 6,
    }),
  ).toBeUndefined();
});

test("same-scope progress selects the stored latest revision and extended coverage", () => {
  const f = fixture();
  f.commit(1, {
    sourceRevision: 8,
    sourceDigests: [f.checkpoint.sourceDigests[0]!],
  });
  const expanded = f.commit(1, { sourceRevision: 9 });
  expect(resolveExecutionEvidenceCheckpoint(f.selection())).toBe(expanded);
  expect(expanded.sourceDigests).toHaveLength(2);
});

test("absent steering retains strict current-objective matching", () => {
  const f = fixture();
  const selected = f.commit(1);
  const { updates: _updates, ...strict } = f.selection();
  expect(resolveExecutionEvidenceCheckpoint(strict)).toBeUndefined();
  expect(
    resolveExecutionEvidenceCheckpoint({
      ...strict,
      objective: projectExecutionCompactionObjective(
        f.resolver.prompt,
        updates.slice(0, 1),
      ),
    }),
  ).toBe(selected);
  expect(resolveExecutionEvidenceCheckpoint(f.resolver)).toBe(
    f.store.get(f.checkpoint.scopeId),
  );
});

test("inconsistent accepted objective and arbitrary same-call objective do not authorize inheritance", () => {
  const f = fixture();
  const objective = "An objective that was never accepted.";
  f.store.commit({
    ...f.checkpoint,
    scopeId: executionCompactionScopeId({ ...f.resolver, objective }),
    objectiveFingerprint: hash(objective),
  });
  expect(
    resolveExecutionEvidenceCheckpoint({ ...f.selection(), objective }),
  ).toBeUndefined();
  expect(
    resolveExecutionEvidenceCheckpoint({
      ...f.selection(),
      objective: f.resolver.prompt,
    }),
  ).toBeUndefined();
  expect(
    resolveExecutionEvidenceCheckpoint({
      ...f.selection(),
      store: undefined,
    }),
  ).toBeUndefined();
});

test.each([
  { requestId: "foreign-request" },
  { prompt: "A different original prompt." },
  { callId: "foreign-call" },
  { scopeSuffix: "response" },
  { allowedConsumers: [MODEL_STEPS.EXECUTION_RESPONSE] },
  { allowedConsumers: [MODEL_STEPS.SUPERVISOR_DECISION] },
])("rejects a selection from another binding %j", (change) => {
  const f = fixture();
  f.commit(1);
  expect(
    resolveExecutionEvidenceCheckpoint({ ...f.selection(), ...change }),
  ).toBeUndefined();
});

test.each([
  { roleId: "worker" },
  { currentRequestFingerprint: hash("another original request") },
  { objectiveFingerprint: hash("another objective") },
  { allowedConsumers: [MODEL_STEPS.SUPERVISOR_DECISION] },
  {
    allowedConsumers: [
      MODEL_STEPS.EXECUTION_DECISION,
      MODEL_STEPS.SUPERVISOR_DECISION,
    ],
  },
])("rejects a checkpoint from another role or consumer family %j", (change) => {
  const f = compactedSourceFixture(undefined, change);
  expect(resolveExecutionEvidenceCheckpoint(f.resolver)).toBeUndefined();
});

test("explicit consumers match the complete ordered EA binding", () => {
  const f = fixture();
  const selected = f.commit(1);
  expect(
    resolveExecutionEvidenceCheckpoint({
      ...f.selection(),
      allowedConsumers: selected.allowedConsumers,
    }),
  ).toBe(selected);
  expect(
    resolveExecutionEvidenceCheckpoint({
      ...f.selection(),
      allowedConsumers: [...selected.allowedConsumers].reverse(),
    }),
  ).toBeUndefined();
});

test("an explicitly selected suffix never borrows evidence from the default continuation", () => {
  const f = fixture();
  const params = { ...f.selection(1), scopeSuffix: "isolated-evidence" };
  const isolated = {
    ...f.checkpoint,
    scopeId: executionCompactionScopeId(params),
    objectiveFingerprint: hash(params.objective),
  };
  f.store.commit(isolated);
  expect(resolveExecutionEvidenceCheckpoint(params)).toBe(
    f.store.get(isolated.scopeId),
  );
  expect(resolveExecutionEvidenceCheckpoint(f.selection(1))).toBe(
    f.store.get(f.checkpoint.scopeId),
  );
});

test.each([
  "missing",
  "changed-content",
  "changed-ref",
  "changed-fingerprint",
] as const)(
  "rejects %s materialization instead of trusting the checkpoint's hash declaration",
  (change) => {
    const f = fixture();
    f.commit(1);
    const store = {
      ...f.store,
      materializeSource(ref: string, fingerprint: string) {
        const source = f.store.materializeSource(ref, fingerprint)!;
        if (change === "missing") return undefined;
        if (change === "changed-content")
          return { ...source, content: "different" };
        if (change === "changed-ref")
          return { ...source, sourceRef: "tool-result:other" };
        return { ...source, sourceFingerprint: hash("different") };
      },
    };
    expect(() =>
      resolveExecutionEvidenceCheckpoint({ ...f.selection(), store }),
    ).toThrow(
      change === "missing"
        ? "context_compaction_inheritance_source_missing"
        : "context_compaction_inheritance_source_identity_invalid",
    );
    expect(
      resolveExecutionEvidenceCheckpoint({
        ...f.resolver,
        store,
      }),
    ).toBeUndefined();
  },
);

test("restore derives inheritance from existing immutable checkpoint and source fields", () => {
  const f = fixture();
  const previous = f.commit(1);
  const snapshot = captureRequestContextCompaction(f.store);
  const restored = restoreRequestContextCompaction(snapshot);
  const selected = resolveExecutionEvidenceCheckpoint({
    ...f.selection(),
    store: restored,
  });
  expect(selected).toBe(restored.get(previous.scopeId));
  expect(selected).toEqual(previous);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
});
