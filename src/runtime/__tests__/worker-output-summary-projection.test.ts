import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { CapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint, restoreRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/index.js";
import { buildCompactedRequestToolResultsMessage, buildRequestToolResultsMessage, projectRequestToolResults } from "../context/request-tool-results.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { readSuperWorkerCompactionSidecar } from "../context/super-worker-compaction-sidecar.js";
import { bindRequestToolResultsMessage } from "../context/request-tool-results-message-binding.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../context/operation-supervision-evidence.js";
import { projectOperationSupervisionEvidenceClosure } from "../context/operation-supervision-evidence-projection.js";
import { createSemanticCompactionSha256Fingerprint as hash, type SemanticCompactionCheckpoint } from "../context/semantic-compaction/contracts.js";
import { createRequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { commit } from "./support/super-mixed-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const OUTPUT = "WORKER_EXACT_OUTPUT:" + "observed detail ".repeat(30).trim();
const REFERENCE = "Independent supplementary reference.";
const PROMPT = "Read the assigned evidence.";

test("a bound Worker projects one exact output without rewriting its canonical summary", async () => {
  const f = await fixture();
  expect(readSuperWorkerCompactionSidecar(f.view)).toBeDefined();
  const before = JSON.stringify({ head: f.head, results: f.view.results, sources: f.sources });
  const message = buildRequestToolResultsMessage(f.view);
  const results = readPacket(message).results;
  expect(results).toHaveLength(2);
  for (const [index, result] of results.entries()) {
    const canonical = f.view.results[index]!;
    const { summary: _summary, ...remaining } = canonical;
    expect(result).toEqual(remaining);
    expect(result).not.toHaveProperty("summary");
    expect(result.referenceData).toBe(REFERENCE);
    expect(JSON.stringify(result).split(OUTPUT)).toHaveLength(2);
    expect(canonical.summary).toBe(OUTPUT);
  }
  expect(buildRequestToolResultsMessage(f.view).content).toBe(message.content);
  expect(JSON.stringify({ head: f.head, results: f.view.results, sources: f.sources })).toBe(before);
  for (const source of f.sources) {
    expect(JSON.parse(source.content).summary).toBe(OUTPUT);
    expect(source.sourceFingerprint).toBe(hash(source.content));
  }
});

test("supplementary summaries and generic result envelopes stay visible", async () => {
  const supplementary = await fixture({ summary: "Additional outcome: verification is pending." });
  for (const result of readPacket(buildRequestToolResultsMessage(supplementary.view)).results)
    expect(result.summary).toBe("Additional outcome: verification is pending.");
  const generic = await fixture({ generic: true });
  for (const result of readPacket(buildRequestToolResultsMessage(generic.view)).results) {
    expect(result.summary).toBe(OUTPUT);
    expect(result.adapterResult).toBeDefined();
  }
});

test.each([
  { name: "leading output whitespace", output: ` ${OUTPUT}`, summary: OUTPUT },
  { name: "trailing output whitespace", output: `${OUTPUT}\n`, summary: OUTPUT },
  { name: "near-equal summary", output: OUTPUT, summary: `${OUTPUT}.` },
])("preserves distinct text with $name", async (options) => {
  const f = await fixture(options);
  for (const result of readPacket(buildRequestToolResultsMessage(f.view)).results) {
    expect(result.summary).toBe(options.summary);
    expect(result.adapterResult.result.output).toBe(options.output);
  }
});

test("summary-only cross-call consumers and unbound builders retain their summary", async () => {
  const f = await fixture();
  const rootView = projectRequestToolResults({
    ledger: f.ledger, head: f.head, callId: f.head.state.rootCallId!, modelStep: "supervisor.decision",
  });
  expect(readSuperWorkerCompactionSidecar(rootView)).toBeUndefined();
  for (const result of readPacket(buildRequestToolResultsMessage(rootView)).results) {
    expect(result.summary).toBe(OUTPUT);
    expect(result).not.toHaveProperty("adapterResult");
    expect(result).not.toHaveProperty("referenceData");
  }
  const unbound = { sourceRevision: f.view.sourceRevision, results: f.view.results };
  expect(readSuperWorkerCompactionSidecar(unbound)).toBeUndefined();
  expect(readPacket(buildRequestToolResultsMessage(unbound)).results).toEqual(f.view.results);
});

test("restored canonical receipts and source hashes stay exact while the fresh uncovered result stays single-copy", async () => {
  const f = await fixture({ park: true });
  const { store, checkpoint } = checkpointForFirstResult(f);
  const snapshot = JSON.parse(JSON.stringify(captureRequestContextCompaction(store)));
  const savedLedger = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(f.ledger)));
  const restoredLedger = restoreRoleCallLedgerCheckpoint(savedLedger, {
    requestId: f.head.state.requestId, policy: f.head.policy,
  });
  const restoredStore = restoreRequestContextCompaction(snapshot);
  const restoredHead = restoredLedger.current();
  const restoredView = projectRequestToolResults({
    ledger: restoredLedger, head: restoredHead, callId: f.call.callId, modelStep: "worker.decision",
  });
  expect(restoredView.results).toEqual(f.view.results);
  expect(restoredView.results.map(createCapabilityResultCompactionSource)).toEqual(f.sources);
  const message = buildCompactedRequestToolResultsMessage(restoredView, checkpoint, {
    requestId: f.head.state.requestId, prompt: PROMPT, head: restoredHead, store: restoredStore,
  });
  const packet = readPacket(message);
  expect(packet.semanticCheckpoint.coveredResults).toHaveLength(1);
  expect(packet.semanticCheckpoint.coveredResults[0]).toMatchObject({
    executionId: f.view.results[0]!.executionId,
    sourceFingerprint: f.sources[0]!.sourceFingerprint,
  });
  expect(packet.semanticCheckpoint.coveredResults[0]).not.toHaveProperty("summary");
  expect(packet.semanticCheckpoint.coveredResults[0]).not.toHaveProperty("adapterResult");
  expect(packet.results).toHaveLength(1);
  const { summary: _summary, ...fresh } = f.view.results[1]!;
  expect(packet.results[0]).toEqual(fresh);
  expect(JSON.stringify(packet.results[0]).split(OUTPUT)).toHaveLength(2);
  expect(captureRequestContextCompaction(restoredStore)).toEqual(snapshot);
  expect(captureRoleCallLedgerCheckpoint(restoredLedger)).toEqual(savedLedger);
  expect(restoredStore.materializeSource(f.sources[0]!.sourceRef, f.sources[0]!.sourceFingerprint)).toEqual(f.sources[0]);
});

test.each(["omitted", "canonical"] as const)("supervision closure accepts a %s summary in the same exact result lane", async (summaryForm) => {
  const f = await fixture();
  let message = buildRequestToolResultsMessage(f.view);
  expect(readPacket(message).results.at(-1)).not.toHaveProperty("summary");
  if (summaryForm === "canonical") {
    const packet = readPacket(message);
    packet.results.at(-1)!.summary = OUTPUT;
    message = bindRequestToolResultsMessage(f.view, JSON.stringify(packet));
  }
  const notice = buildImmediateOperationSupervisionEvidenceMessage(f.head, f.call)!;
  const messages = projectOperationSupervisionEvidenceClosure([message, notice], supervisionContext(f));
  expect(messages[0]).toBe(message);
  expect(readPacket(messages[1]!).entries[0].evidence).toEqual({
    kind: "existing_exact_capability_result_lane", executionId: f.view.results.at(-1)!.executionId,
  });
  expect(projectOperationSupervisionEvidenceClosure(messages, supervisionContext(f))).toEqual(messages);
});

test("supervision closure rejects omission of a supplementary summary", async () => {
  const f = await fixture({ summary: "Independent verification remains pending." });
  const message = buildRequestToolResultsMessage(f.view);
  const packet = readPacket(message);
  delete packet.results.at(-1)!.summary;
  const malformed = bindRequestToolResultsMessage(f.view, JSON.stringify(packet));
  const notice = buildImmediateOperationSupervisionEvidenceMessage(f.head, f.call)!;
  expect(() => projectOperationSupervisionEvidenceClosure([malformed, notice], supervisionContext(f)))
    .toThrow("operation_supervision_evidence_exact_lane_invalid");
});

test("supervision closure rejects tampered output even when the original summary was omitted", async () => {
  const f = await fixture();
  const packet = readPacket(buildRequestToolResultsMessage(f.view));
  expect(packet.results.at(-1)).not.toHaveProperty("summary");
  packet.results.at(-1)!.adapterResult.result.output = "Different evidence.";
  const malformed = bindRequestToolResultsMessage(f.view, JSON.stringify(packet));
  const notice = buildImmediateOperationSupervisionEvidenceMessage(f.head, f.call)!;
  expect(() => projectOperationSupervisionEvidenceClosure([malformed, notice], supervisionContext(f)))
    .toThrow("operation_supervision_evidence_exact_lane_invalid");
});

function readPacket(message: ChatMessage) {
  return JSON.parse(message.content);
}

function supervisionContext(f: Awaited<ReturnType<typeof fixture>>) {
  return { requestId: f.head.state.requestId, call: f.call, sourceRevision: f.head.revision,
    consumer: "worker.decision" as const };
}

function checkpointForFirstResult(f: Awaited<ReturnType<typeof fixture>>) {
  const source = f.sources[0]!;
  const store = createRequestContextCompactionStore();
  store.registerSources([source]);
  const checkpoint: SemanticCompactionCheckpoint = {
    kind: "runtime_semantic_compaction_checkpoint_v2",
    requestId: f.head.state.requestId, currentRequestFingerprint: hash(PROMPT),
    roleId: "worker", callId: f.call.callId, objectiveFingerprint: hash(f.call.objective!),
    contextLane: "role_continuation", scopeId: `worker:${f.call.callId}:request-tool-results`,
    sourceRevision: f.firstRevision,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    sourceDigests: [{ sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint,
      digest: "Earlier result was observed; verification remains pending." }],
    continuation: createSuperContinuation("Preserve the previous partial observation."),
  };
  store.commit(checkpoint);
  return { store, checkpoint };
}

async function fixture(options: { summary?: string; output?: string; generic?: boolean; park?: boolean } = {}) {
  const ledger = createRoleCallLedger({
    requestId: "worker-summary-projection",
    policy: { limits: { maxDepth: 12, maxCalls: 48, maxCapabilityExecutions: 96,
      maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536 } },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, { authority: "active_role", type: "open_child",
    callerCallId: "call-1", roleId: "worker", objective: PROMPT });
  let firstRevision = 0;
  for (let index = 0; index < 2; index++) {
    const call = ledger.current().state.calls.at(-1)!;
    await commit(ledger, {
      authority: "active_role", type: "begin_capability_execution", callId: call.callId,
      invocationAttempt: call.activationCount, capabilityId: "files.read", declaredEffect: "observation",
      intent: "Read the assigned evidence.", controlsJson: '{"path":"evidence.txt"}',
      actionFingerprint: hash("same accepted observation"),
    });
    const exactResult: CapabilityAdapterResult = options.generic
      ? { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
          ok: true, payload: { output: options.output ?? OUTPUT } }
      : { kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
          result: { ok: true, tool: "files.read", output: options.output ?? OUTPUT, producedNewInformation: true } };
    await commit(ledger, {
      authority: "runtime", type: "settle_capability_execution", callId: call.callId,
      executionId: ledger.current().state.capabilityExecutions.at(-1)!.executionId,
      outcome: "succeeded", observedEffect: "observation", outcomeFingerprint: "succeeded",
      summary: options.summary ?? OUTPUT, referenceData: REFERENCE, exactResult,
    });
    if (index === 0) firstRevision = ledger.current().revision;
  }
  if (options.park) {
    const call = ledger.current().state.calls.at(-1)!;
    await commit(ledger, {
      authority: "active_role", type: "begin_capability_execution", callId: call.callId,
      invocationAttempt: call.activationCount, capabilityId: "files.read", declaredEffect: "observation",
      intent: "Read the next evidence.", controlsJson: '{"path":"next.txt"}',
      actionFingerprint: hash("next accepted observation"),
    });
  }
  const head = ledger.current();
  const call = head.state.calls.at(-1)!;
  const view = projectRequestToolResults({ ledger, head, callId: call.callId, modelStep: "worker.decision" });
  const sources = view.results.map(createCapabilityResultCompactionSource);
  return { ledger, head, call, view, sources, firstRevision };
}
