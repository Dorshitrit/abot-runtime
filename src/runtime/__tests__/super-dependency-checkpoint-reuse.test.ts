import { afterEach, beforeEach, expect, test } from "vitest";
import type { ModelStep } from "../../shared/model-steps.js";
import {
  projectSemanticCompactionDependencyResults,
  type SemanticCompactionDependencyResult,
} from "../context/semantic-compaction/dependency-results.js";
import type { RequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionCheckpoint,
} from "../context/semantic-compaction/contracts.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "../context/semantic-compaction/evidence-scope.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { projectRoleCallDependencyResults } from "../orchestration/role-calls/index.js";
import {
  dependencyObservationFixture,
  SELECTED_SOURCE,
  NESTED_SOURCE,
} from "./support/super-dependency-observation-fixture.js";
import { createDependencyCheckpoints } from "./support/super-dependency-compaction-fixture.js";

import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof dependencyObservationFixture>>;

function projectDependencies(
  fixture: Fixture,
  store: RequestContextCompactionStore,
  head = fixture.head,
  consumer: ModelStep = "worker.evidence",
) {
  return projectSemanticCompactionDependencyResults({
    requestId: fixture.requestId, prompt: fixture.prompt,
    head, call: fixture.call, consumer, store,
  });
}

function canonicalResults(results: readonly SemanticCompactionDependencyResult[]) {
  return results.map(({ semanticCheckpoints: _checkpoints, observations: _observations, ...result }) => result);
}

function projectedScopes(results: readonly SemanticCompactionDependencyResult[]) {
  return results.flatMap(result => result.semanticCheckpoints ?? []).map(checkpoint => checkpoint.scopeId);
}

test("SUPER carries each transitive checkpoint once without changing selected results or reviving raw evidence", async () => {
  const fixture = await dependencyObservationFixture({ selectFirstDirectly: true });
  const { store, checkpoints } = createDependencyCheckpoints(fixture);
  const before = JSON.stringify({ head: fixture.head, snapshot: captureRequestContextCompaction(store) });
  const canonicalCheckpoint = store.findByCallIds([fixture.firstProducer.callId])[0]!;
  expect(store.findByCallIds([fixture.firstProducer.callId])[0]).toBe(canonicalCheckpoint);
  expect(store.get(canonicalCheckpoint.scopeId)).toBe(canonicalCheckpoint);
  expect(Object.isFrozen(canonicalCheckpoint)).toBe(true);
  const projected = projectDependencies(fixture, store);
  expect(projectedScopes(projected)).toEqual(checkpoints.map(checkpoint => checkpoint.scopeId));
  expect(projected[0]!.semanticCheckpoints).toHaveLength(2);
  expect(projected[1]!.semanticCheckpoints).toBeUndefined();
  expect(canonicalResults(projected)).toEqual(fixture.dependencyResults);
  expect(projected.every(result => result.observations === undefined)).toBe(true);
  expect(projected.map(result => result.resultRef)).toEqual(fixture.call.dependencyResultRefs);
  const text = JSON.stringify(projected);
  for (const checkpoint of checkpoints)
    for (const digest of checkpoint.sourceDigests)
      expect(text.split(digest.digest)).toHaveLength(2);
  for (const raw of [SELECTED_SOURCE, NESTED_SOURCE])
    expect(text).not.toContain(JSON.stringify(raw).slice(1, -1));
  expect(text).not.toContain(fixture.unselectedResult.resultRef);
  expect(Object.isFrozen(projected)).toBe(true);
  expect(projected.every(Object.isFrozen)).toBe(true);
  expect(JSON.stringify({ head: fixture.head, snapshot: captureRequestContextCompaction(store) })).toBe(before);
});

test("snapshot restoration preserves the same first checkpoint carrier and canonical source bytes", async () => {
  const fixture = await dependencyObservationFixture({ selectFirstDirectly: true });
  const { store, sources, checkpoints } = createDependencyCheckpoints(fixture);
  const snapshot = JSON.parse(JSON.stringify(captureRequestContextCompaction(store)));
  const restored = restoreRequestContextCompaction(snapshot);
  const projected = projectDependencies(fixture, restored);
  expect(projected).toEqual(projectDependencies(fixture, store));
  expect(projectedScopes(projected)).toEqual(checkpoints.map(checkpoint => checkpoint.scopeId));
  for (const source of sources)
    expect(restored.materializeSource(source.sourceRef, source.sourceFingerprint)).toEqual(source);
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);
});

const invalidDuplicates = [
  {
    name: "objective binding",
    corrupt: (checkpoint: SemanticCompactionCheckpoint) => ({
      ...checkpoint, objectiveFingerprint: hash("different objective"),
    }),
    error: "context_compaction_checkpoint_objective_invalid",
  },
  {
    name: "consumer binding",
    corrupt: (checkpoint: SemanticCompactionCheckpoint) => ({
      ...checkpoint, allowedConsumers: ["worker.decision"] as const,
    }),
    error: "context_compaction_checkpoint_consumers_invalid",
  },
  {
    name: "source fingerprint",
    corrupt: (checkpoint: SemanticCompactionCheckpoint) => ({
      ...checkpoint,
      sourceDigests: checkpoint.sourceDigests.map(digest => ({
        ...digest, sourceFingerprint: hash("different source"),
      })),
    }),
    error: "context_compaction_source_materialization_missing",
  },
];

test.each(invalidDuplicates)("validates repeated $name before omitting a duplicate scope", async ({ corrupt, error }) => {
  const fixture = await dependencyObservationFixture({ selectFirstDirectly: true });
  const { store } = createDependencyCheckpoints(fixture);
  let reads = 0;
  const corrupted: RequestContextCompactionStore = {
    ...store,
    findByCallIds(callIds) {
      const checkpoints = store.findByCallIds(callIds);
      reads += 1;
      return reads === 2 ? checkpoints.map(corrupt) : checkpoints;
    },
  };
  expect(() => projectDependencies(fixture, corrupted)).toThrow(error);
  expect(reads).toBe(2);
});

test("a disallowed consumer receives no checkpoints and retains selected raw observations", async () => {
  const fixture = await dependencyObservationFixture({ selectFirstDirectly: true });
  const { store } = createDependencyCheckpoints(fixture);
  const projected = projectDependencies(fixture, store, fixture.head, "supervisor.response");
  expect(projectedScopes(projected)).toEqual([]);
  expect(canonicalResults(projected)).toEqual(fixture.dependencyResults);
  expect(projected.flatMap(result => result.observations ?? []).map(result => result.executionId))
    .toEqual([fixture.firstExecutionId, fixture.nestedExecutionId]);
});

test.each(["EA", "altered SUPER"] as const)("%s preserves the original repeated-checkpoint projection byte for byte", async policy => {
  const fixture = await dependencyObservationFixture({ selectFirstDirectly: true });
  const { store, checkpoints } = createDependencyCheckpoints(fixture);
  const authority = policy === "EA"
    ? resolveRequestExecutionPolicy("execution-agent-v1").authority
    : { ...fixture.head.policy.authority, definitionHash: "different" };
  const head = { ...fixture.head, policy: { ...fixture.head.policy, authority } };
  const firstCheckpoint = checkpoints.find(checkpoint => checkpoint.callId === fixture.firstProducer.callId)!;
  const withScope = (checkpoint: SemanticCompactionCheckpoint) => ({
    ...checkpoint, evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
  });
  const canonical = projectRoleCallDependencyResults(head, fixture.call);
  const expected = [
    { ...canonical[0], semanticCheckpoints: checkpoints.map(withScope) },
    { ...canonical[1], semanticCheckpoints: [withScope(firstCheckpoint)] },
  ];
  const projected = projectDependencies(fixture, store, head);
  expect(projected).toEqual(expected);
  expect(JSON.stringify(projected)).toBe(JSON.stringify(expected));
  expect(projectedScopes(projected)).toHaveLength(3);
});
