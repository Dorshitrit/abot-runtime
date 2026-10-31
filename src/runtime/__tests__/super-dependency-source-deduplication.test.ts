import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import * as mainCompaction from "../context/model-step-compaction-projection.js";
import {
  resolveSuperDependencyObservationCompaction,
} from "../context/super-dependency-observation-compaction.js";
import {
  readSuperWorkerCompactionSidecar,
  type SuperWorkerCompactionSidecar,
} from "../context/super-worker-compaction-sidecar.js";
import {
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import { projectSuperDependencyObservations } from "../context/super-dependency-observations.js";
import { prepareSuperSourceInventory } from "../context/super-compaction/source-inventory.js";
import { CompactionSourceInvariantError } from "../context/compaction-source-invariant.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
} from "../context/semantic-compaction/index.js";
import type { SemanticCompactionGenerationParams } from "../context/semantic-compaction/generation-contracts.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  commitDependencyCommand,
  dependencyObservationFixture,
  SELECTED_SOURCE,
  NESTED_SOURCE,
} from "./support/super-dependency-observation-fixture.js";
import { createDependencyCheckpoints } from "./support/super-dependency-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const OWN_SOURCE = "CONSUMER_NEW_OBSERVATION_BYTES";
type DependencyFixture = Awaited<ReturnType<typeof dependencyObservationFixture>>;

async function settleConsumerObservation(fixture: DependencyFixture) {
  const { ledger, call } = fixture;
  await commitDependencyCommand(ledger, {
    authority: "active_role", type: "begin_capability_execution",
    callId: call.callId, invocationAttempt: call.activationCount,
    capabilityId: "execute_command", declaredEffect: "mixed",
    intent: "Read the remaining assigned source.",
    controlsJson: '{"command":"cat remaining-source","cwd":"."}',
    actionFingerprint: hash("consumer-observation:" + call.callId),
  });
  const executionId = ledger.current().state.capabilityExecutions.at(-1)!.executionId;
  await commitDependencyCommand(ledger, {
    authority: "runtime", type: "settle_capability_execution",
    callId: call.callId, executionId, outcome: "succeeded",
    observedEffect: "observation", summary: "The remaining source was observed.",
    exactResult: {
      kind: "registered_tool_execution_result_v1",
      authority: "registered_plugin", status: "executed",
      result: {
        ok: true, tool: "exec", output: "The remaining source was observed.",
        stdout: OWN_SOURCE, exitCode: 0, progress: false, producedNewInformation: true,
      },
    },
  });
  return executionId;
}

async function overlappingSourcesFixture() {
  const fixture = await dependencyObservationFixture();
  const ownExecutionId = await settleConsumerObservation(fixture);
  const head = fixture.ledger.current();
  const call = head.state.calls.find(candidate => candidate.callId === fixture.call.callId)!;
  const view = projectRequestToolResults({
    ledger: fixture.ledger, head, callId: call.callId, modelStep: "worker.decision",
  });
  const sidecar = readSuperWorkerCompactionSidecar(view)!;
  const assignment: ChatMessage = {
    role: "user",
    content: JSON.stringify({
      kind: "runtime_worker_assignment", callId: call.callId, objective: call.objective,
      dependencyResults: projectSuperDependencyObservations(
        head, call, fixture.dependencyResults,
      ),
    }),
  };
  const receiptMessage = buildRequestToolResultsMessage(view);
  const sourceMap = new Map(sidecar.sources.map(source => [source.sourceRef, source]));
  const projection = resolveSuperDependencyObservationCompaction(sidecar);
  return {
    ...fixture, head, call, ownExecutionId, view, sidecar,
    assignment, receiptMessage, sourceMap, projection,
    scopeId: `worker:${call.callId}:request-tool-results`,
  };
}

test.each(["before-resume", "after-resume"] as const)(
  "%s overlapping dependency bodies and summary receipts compact once with original bytes",
  async phase => {
    const fixture = await overlappingSourcesFixture();
    const {
      assignment, receiptMessage, projection, sourceMap, scopeId,
      firstExecutionId, nestedExecutionId, ownExecutionId,
    } = fixture;
    for (const executionId of [firstExecutionId, nestedExecutionId]) {
      const receipt = fixture.view.results.find(result => result.executionId === executionId)!;
      expect(receipt).not.toHaveProperty("adapterResult");
      expect(receipt).not.toHaveProperty("referenceData");
    }
    expect(fixture.view.results.find(result => result.executionId === ownExecutionId))
      .toHaveProperty("adapterResult");
    const messages = phase === "after-resume"
      ? [assignment, receiptMessage] : [receiptMessage, assignment];
    const scanned = projection.scanCompactionSources(messages, scopeId, sourceMap);
    const sources = scanned.map(entry => entry.source);
    expect(sources.map(source => source.sourceRef))
      .toEqual([firstExecutionId, nestedExecutionId, ownExecutionId]);
    expect(sources).toHaveLength(3);
    for (const source of sources) {
      expect(source).toEqual(sourceMap.get(source.sourceRef));
      expect(source.sourceFingerprint).toBe(hash(source.content));
    }
    expect(sources.some(source => source.sourceRef === fixture.unselectedExecutionId)).toBe(false);

    const checkpoint = createDependencyCheckpoints(fixture, {
      sources, consumerOwned: true,
    }).checkpoints[0]!;
    const store = createRequestContextCompactionStore();
    const request = {
      requestId: fixture.requestId, prompt: fixture.prompt, contextCompactionStore: store,
    } as SemanticCompactionGenerationParams["request"];
    const inventory = prepareSuperSourceInventory({
      request, scopeId, binding: checkpoint, sourceRevision: fixture.head.revision,
      preservationObjective: fixture.call.objective!, sources, consumer: "worker.evidence",
    });
    expect(inventory).toEqual(sources);
    for (const source of sources)
      expect(store.materializeSource(source.sourceRef, source.sourceFingerprint)).toEqual(source);
    store.commit(checkpoint);

    const projected = projection.projectCheckpointMessages(
      messages, scopeId, checkpoint, sourceMap, true,
    );
    expect(projection.scanCompactionSources(projected, scopeId, sourceMap)).toEqual([]);
    const projectedAssignment = projected.map(message => JSON.parse(message.content))
      .find(record => record.kind === "runtime_worker_assignment");
    expect(projectedAssignment.callId).toBe(fixture.call.callId);
    expect(projectedAssignment.dependencyResults.every(
      (dependency: { observations?: unknown }) => dependency.observations === undefined,
    )).toBe(true);
    const projectedText = JSON.stringify(projected);
    for (const sourceText of [SELECTED_SOURCE, NESTED_SOURCE, OWN_SOURCE])
      expect(projectedText).not.toContain(JSON.stringify(sourceText).slice(1, -1));
    for (const digest of checkpoint.sourceDigests)
      expect(projectedText.split(digest.digest)).toHaveLength(2);

    const restored = restoreRequestContextCompaction(
      JSON.parse(JSON.stringify(captureRequestContextCompaction(store))),
    );
    const restoredCheckpoint = restored.get(scopeId)!;
    expect(projection.projectCheckpointMessages(
      messages, scopeId, restoredCheckpoint, sourceMap, true,
    )).toEqual(projected);
    for (const source of sources)
      expect(restored.materializeSource(source.sourceRef, source.sourceFingerprint)).toEqual(source);
  },
);

test("SUPER rejects repeated source identity with changed bytes before registration", async () => {
  const fixture = await overlappingSourcesFixture();
  const first: ChatMessage = {
    role: "tool", toolName: "fixture_read", toolCallId: "repeated-call", content: "ORIGINAL_BYTES",
  };
  const changed: ChatMessage = { ...first, content: "CHANGED_BYTES" };
  expect(() => fixture.projection.scanCompactionSources(
    [first, changed], fixture.scopeId, fixture.sourceMap,
  )).toThrow(CompactionSourceInvariantError);
  expect(() => fixture.projection.scanCompactionSources(
    [first, changed], fixture.scopeId, fixture.sourceMap,
  )).toThrow("context_compaction_source_identity_conflict");
  expect(fixture.sourceMap.size).toBe(3);
  expect(fixture.sourceMap.has("tool-result:repeated-call")).toBe(false);
});

test("SUPER collapses identical ordinary carriers without changing their canonical bytes", async () => {
  const fixture = await overlappingSourcesFixture();
  const message: ChatMessage = {
    role: "tool", toolName: "fixture_read", toolCallId: "repeated-call", content: "ORIGINAL_BYTES",
  };
  const original = mainCompaction.scanCompactionSources(
    [message], fixture.scopeId, fixture.sourceMap,
  );
  expect(fixture.projection.scanCompactionSources(
    [message, { ...message }], fixture.scopeId, fixture.sourceMap,
  )).toEqual(original);
});

test("absent and EA authority retain the exact MAIN scanner and its repeated-carrier behavior", async () => {
  const fixture = await overlappingSourcesFixture();
  const eaSidecar: SuperWorkerCompactionSidecar = {
    ...fixture.sidecar,
    head: {
      ...fixture.head,
      policy: {
        ...fixture.head.policy,
        authority: resolveRequestExecutionPolicy("execution-agent-v1").authority,
      },
    },
  };
  const message: ChatMessage = {
    role: "tool", toolName: "fixture_read", toolCallId: "repeated-call", content: "ORIGINAL_BYTES",
  };
  const messages = [message, { ...message }];
  for (const sidecar of [undefined, eaSidecar]) {
    const projection = resolveSuperDependencyObservationCompaction(sidecar);
    expect(projection.scanCompactionSources).toBe(mainCompaction.scanCompactionSources);
    expect(projection.projectCheckpointMessages).toBe(mainCompaction.projectCheckpointMessages);
    const scanned = projection.scanCompactionSources(messages, fixture.scopeId, new Map());
    expect(scanned).toEqual(mainCompaction.scanCompactionSources(messages, fixture.scopeId, new Map()));
    expect(scanned).toHaveLength(2);
  }
});
