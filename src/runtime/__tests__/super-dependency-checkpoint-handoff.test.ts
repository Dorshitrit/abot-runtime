import { afterEach, beforeEach, expect, test } from "vitest";
import {
  buildCompactedRequestToolResultsMessage,
  buildRequestToolResultsMessage,
  projectRequestToolResults,
} from "../context/request-tool-results.js";
import { projectSuperCompactedRequestToolResults } from "../context/super-request-tool-results-checkpoint.js";
import { isRequestToolResultsMessageBoundToView } from "../context/request-tool-results-message-binding.js";
import { readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import {
  createRequestContextCompactionStore,
  createSemanticCompactionSha256Fingerprint as hash,
} from "../context/semantic-compaction/index.js";
import {
  captureRequestContextCompaction,
  restoreRequestContextCompaction,
} from "../context/semantic-compaction/snapshot.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { projectCanonicalRequestToolResult } from "../context/canonical-capability-result.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  commitDependencyCommand,
  dependencyObservationFixture,
  SELECTED_SOURCE,
  NESTED_SOURCE,
  UNSELECTED_SOURCE,
} from "./support/super-dependency-observation-fixture.js";
import { createDependencyCheckpoints } from "./support/super-dependency-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const OWN_SOURCE = "CONSUMER_HANDOFF_ORIGINAL_BYTES";
type Fixture = Awaited<ReturnType<typeof dependencyObservationFixture>>;

async function settleOwnObservation(fixture: Fixture) {
  await commitDependencyCommand(fixture.ledger, {
    authority: "active_role", type: "begin_capability_execution",
    callId: fixture.call.callId, invocationAttempt: fixture.call.activationCount,
    capabilityId: "execute_command", declaredEffect: "observation",
    intent: "Read the final assigned source.", controlsJson: "{}",
    actionFingerprint: hash("handoff:" + fixture.call.callId),
  });
  const executionId = fixture.ledger.current().state.capabilityExecutions.at(-1)!.executionId;
  await commitDependencyCommand(fixture.ledger, {
    authority: "runtime", type: "settle_capability_execution",
    callId: fixture.call.callId, executionId,
    outcome: "succeeded", observedEffect: "observation", summary: "Final source observed.",
    exactResult: {
      kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
      result: { ok: true, tool: "exec", output: "Final source observed.", stdout: OWN_SOURCE,
        exitCode: 0, progress: false, producedNewInformation: true },
    },
  });
}

async function handoffFixture(includeOwn = true) {
  const base = await dependencyObservationFixture({ selectFirstDirectly: true });
  if (includeOwn) await settleOwnObservation(base);
  const head = base.ledger.current();
  const call = head.state.calls.find(candidate => candidate.callId === base.call.callId)!;
  const fixture = { ...base, head, call };
  const view = projectRequestToolResults({
    ledger: base.ledger, head, callId: call.callId, modelStep: "worker.decision",
  });
  const sidecar = readSuperWorkerCompactionSidecar(view)!;
  const compacted = createDependencyCheckpoints(fixture, {
    sources: sidecar.sources, consumerOwned: true,
  });
  return { ...fixture, view, ...compacted, checkpoint: compacted.checkpoints[0]! };
}

function integrity(fixture: Awaited<ReturnType<typeof handoffFixture>>, store = fixture.store) {
  return { requestId: fixture.requestId, prompt: fixture.prompt, head: fixture.head, store };
}

test.each([false, true])("restored handoff uses original selected-source fingerprints with own result present: %s", async includeOwn => {
  const fixture = await handoffFixture(includeOwn);
  const { view, checkpoint, sources, store } = fixture;
  const original = JSON.parse(buildRequestToolResultsMessage(view).content);
  for (const executionId of [fixture.firstExecutionId, fixture.nestedExecutionId]) {
    const receipt = view.results.find(result => result.executionId === executionId)!;
    expect(receipt).not.toHaveProperty("adapterResult");
    expect(receipt).not.toHaveProperty("referenceData");
  }
  const before = JSON.stringify(captureRequestContextCompaction(store));
  const restored = restoreRequestContextCompaction(JSON.parse(before));
  const projected = buildCompactedRequestToolResultsMessage(view, checkpoint, integrity(fixture));
  const fromRestored = buildCompactedRequestToolResultsMessage(
    view, restored.get(checkpoint.scopeId)!, integrity(fixture, restored),
  );
  expect(fromRestored.content).toBe(projected.content);
  expect(isRequestToolResultsMessageBoundToView(projected, view)).toBe(true);
  expect(isRequestToolResultsMessageBoundToView(fromRestored, view)).toBe(true);
  const record = JSON.parse(projected.content);
  expect(record.semanticCheckpoint.scopeId).toBe(checkpoint.scopeId);
  expect(record.semanticCheckpoint.coveredSources).toEqual(checkpoint.sourceDigests);
  const covered = record.semanticCheckpoint.coveredResults as { executionId: string; sourceFingerprint: string }[];
  expect(covered.map(result => result.executionId).sort()).toEqual(sources.map(source => source.sourceRef).sort());
  for (const source of sources)
    expect(covered.find(result => result.executionId === source.sourceRef)?.sourceFingerprint).toBe(source.sourceFingerprint);
  expect(record.results).toEqual(original.results.filter(
    (result: { executionId: string }) => result.executionId === fixture.unselectedExecutionId,
  ));
  expect(record.results).toHaveLength(1);
  for (const raw of [SELECTED_SOURCE, NESTED_SOURCE, OWN_SOURCE, UNSELECTED_SOURCE])
    expect(projected.content).not.toContain(JSON.stringify(raw).slice(1, -1));
  for (const digest of checkpoint.sourceDigests)
    expect(projected.content.split(digest.digest)).toHaveLength(2);
  const repeated = projectSuperCompactedRequestToolResults(view, checkpoint, integrity(fixture), projected);
  expect(repeated.content).toBe(projected.content);
  expect(isRequestToolResultsMessageBoundToView(repeated, view)).toBe(true);
  expect(JSON.stringify(captureRequestContextCompaction(store))).toBe(before);
});

test("handoff rejects a changed dependency fingerprint before substituting receipts", async () => {
  const fixture = await handoffFixture();
  const checkpoint = {
    ...fixture.checkpoint,
    sourceDigests: fixture.checkpoint.sourceDigests.map(digest => digest.sourceRef === fixture.firstExecutionId
      ? { ...digest, sourceFingerprint: hash("unregistered bytes") } : digest),
  };
  expect(() => buildCompactedRequestToolResultsMessage(fixture.view, checkpoint, integrity(fixture)))
    .toThrow("context_compaction_source_materialization_missing");
});

test("handoff rejects changed stored dependency bytes even when their new fingerprint is valid", async () => {
  const fixture = await handoffFixture();
  const store = createRequestContextCompactionStore();
  const sources = fixture.sources.map(source => {
    if (source.sourceRef !== fixture.firstExecutionId) return source;
    const content = JSON.stringify({ ...JSON.parse(source.content), summary: "Altered immutable observation." });
    return { ...source, content, sourceFingerprint: hash(content) };
  });
  store.registerSourcesAtomically!(sources);
  const checkpoint = {
    ...fixture.checkpoint,
    sourceDigests: fixture.checkpoint.sourceDigests.map(digest => ({
      ...digest, sourceFingerprint: sources.find(source => source.sourceRef === digest.sourceRef)!.sourceFingerprint,
    })),
  };
  store.commit(checkpoint);
  expect(() => buildCompactedRequestToolResultsMessage(fixture.view, checkpoint, integrity(fixture, store)))
    .toThrow("context_compaction_execution_source_changed");
});

test("handoff rejects a different checkpoint call binding", async () => {
  const fixture = await handoffFixture();
  const checkpoint = { ...fixture.checkpoint, callId: fixture.firstProducer.callId };
  expect(() => buildCompactedRequestToolResultsMessage(fixture.view, checkpoint, integrity(fixture)))
    .toThrow("context_compaction_source_call_invalid");
});

test("a consumer handoff cannot claim an unselected sibling source", async () => {
  const fixture = await handoffFixture();
  const execution = fixture.head.state.capabilityExecutions.find(
    result => result.executionId === fixture.unselectedExecutionId,
  )!;
  const source = createCapabilityResultCompactionSource(projectCanonicalRequestToolResult(fixture.head, execution));
  const compacted = createDependencyCheckpoints(fixture, { sources: [source], consumerOwned: true });
  expect(() => buildCompactedRequestToolResultsMessage(
    fixture.view, compacted.checkpoints[0]!, integrity(fixture, compacted.store),
  )).toThrow("context_compaction_execution_owner_invalid");
});
