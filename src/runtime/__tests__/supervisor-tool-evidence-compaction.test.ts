import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import { createSupervisorToolEvidence } from "../context/supervisor-tool-evidence.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/index.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { assertSuperCompactionCheckpointIntegrity, assertSuperCompactionSourceIntegrity } from "../context/semantic-compaction/super-source-integrity.js";
import {
  assertSupervisorReceiptCompactionSource, createSupervisorReceiptCompactionSource,
  isSupervisorReceiptExecutionEligible, supervisorReceiptSourceRef,
} from "../context/semantic-compaction/supervisor-receipt-source.js";
import { generateSuperCompactionCandidate } from "../context/super-compaction/run.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { projectSuperContinuation } from "../context/super-compaction/continuation-projection.js";
import { runSupervisorResponse } from "../steps/supervisor-response/run.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { mixedWorkerFixture, commit } from "./support/super-mixed-compaction-fixture.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const prompt = "Inspect the target.";
const freshSummary = "FRESH_PARENT_OBSERVATION: target is available; " + "source detail ".repeat(500).trim();
const compactSummary = "COMPACT_PARENT_OBSERVATION: target is available.";

test.each([false, true])("fresh Supervisor receipts compact and restore with distinct identity through Planner=%s", async (throughPlanner) => {
  const f = await fixture(throughPlanner);
  const before = captureRequestContextCompaction(f.store);
  const options = { head: f.head, callId: f.root.callId, toolResults: f.toolResults };
  const evidence = createSupervisorToolEvidence(f.request, options)!;
  const sources = evidence.compaction.scanCompactionSources(evidence.buildMessages(), f.scopeId, new Map())
    .map(({ source }) => source);
  const fresh = sources.find(({ sourceRef }) => sourceRef === supervisorReceiptSourceRef(f.root.callId, f.executionId))!;
  expect(fresh).toBeDefined();
  expect(fresh.sourceRef).not.toBe(f.fullSource.sourceRef);
  expect(fresh.sourceFingerprint).not.toBe(f.fullSource.sourceFingerprint);
  expect(fresh.content).toContain(freshSummary);
  expect(fresh.content).not.toContain("HIDDEN_ADAPTER_BODY");
  expect(fresh.content).not.toContain("referenceData");
  const controller = f.controller(evidence);
  const messages: readonly ChatMessage[] = [
    { role: "system", content: "Preserve the observed facts when responding." },
    { role: "user", content: prompt }, ...evidence.buildMessages(),
  ];
  const prepared = await controller.getStages()[0]!.prepare(controller.project(messages));
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error("parent_receipt_preparation_missing");
  expect(f.store.get(f.scopeId)).toBeUndefined();
  expect(prepared.preparation.hasExhaustedCompactionSources).toBe(true);
  expect(f.sentSourceRefs).toContain(fresh.sourceRef);
  expect(f.sentSourceRefs.every((sourceRef) => sourceRef.startsWith("supervisor-receipt:"))).toBe(true);
  expect(f.sentSourceRefs).not.toContain(f.fullSource.sourceRef);
  expect(JSON.stringify(prepared.preparation.messages)).not.toContain(freshSummary);
  expect(JSON.stringify(prepared.preparation.messages)).toContain(compactSummary);
  prepared.preparation.commit();
  const checkpoint = f.store.get(f.scopeId)!;
  expect(checkpoint.sourceDigests.find((digest) => digest.sourceRef === fresh.sourceRef))
    .toMatchObject({ sourceFingerprint: fresh.sourceFingerprint, digest: expect.stringContaining(compactSummary) });
  expect(checkpoint.sourceDigests.every((digest) => sources.some((source) =>
    source.sourceRef === digest.sourceRef && source.sourceFingerprint === digest.sourceFingerprint))).toBe(true);
  const integrity = { requestId: f.request.requestId, prompt, head: f.head, store: f.store };
  expect(() => assertSuperCompactionSourceIntegrity(integrity)).not.toThrow();
  expect(() => assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint })).not.toThrow();
  for (const original of before.sources)
    expect(f.store.materializeSource(original.sourceRef, original.sourceFingerprint)).toEqual(original);
  expect(f.store.get(f.checkpoint.scopeId)).toEqual(f.checkpoint);
  expect(f.store.materializeSource(fresh.sourceRef, fresh.sourceFingerprint)).toEqual(fresh);

  const snapshot = captureRequestContextCompaction(f.store);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(snapshot)));
  const request = deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restored });
  const restoredEvidence = createSupervisorToolEvidence(request, options)!;
  const restoredController = f.controller(restoredEvidence, request);
  const restoredMessages = restoredController.project([
    ...messages.slice(0, 2), ...restoredEvidence.buildMessages(),
  ]);
  expect(restoredMessages).toEqual(prepared.preparation.messages);
  expect(restoredController.hasExhaustedVerifiedCompactionSources?.(restoredMessages)).toBe(true);
  expect(restoredEvidence.compaction.scanCompactionSources(restoredMessages, f.scopeId, new Map())).toEqual([]);
  expect(() => assertSuperCompactionSourceIntegrity({ ...integrity, store: restored })).not.toThrow();
  expect(captureRequestContextCompaction(restored)).toEqual(snapshot);

  // The actual Supervisor path must count and send exactly the projected parent evidence.
  expect(await runSupervisorResponse(request, {
    call: f.identity, toolResults: f.toolResults, skillReadHead: f.head,
  })).toBe("The inspected target is available.");
  expect(f.responseInputs).toHaveLength(1);
  expect(JSON.stringify(f.responseInputs[0])).toContain(compactSummary);
  expect(JSON.stringify(f.responseInputs[0])).not.toContain(freshSummary);
  expect(JSON.stringify(f.responseInputs[0])).not.toContain("HIDDEN_ADAPTER_BODY");
  expect(f.responseCounts.at(-1)).toEqual(f.responseInputs[0]);
  expect(f.store.get(f.scopeId)).toEqual(checkpoint);
});

test("receipt source restore rejects tampering, other consumers, and producer objective drift", async () => {
  const f = await fixture(true);
  const input = { head: f.head, consumerCallId: f.root.callId, executionId: f.executionId };
  const source = createSupervisorReceiptCompactionSource(input);
  const check = (candidate = source) => assertSupervisorReceiptCompactionSource({
    source: candidate, head: f.head, scopeCall: f.root,
  });
  expect(check).not.toThrow();
  const record = JSON.parse(source.content);
  const changed = JSON.stringify({ ...record, receipt: { ...record.receipt, summary: "Invented parent observation" } });
  expect(() => check({ ...source, content: changed, sourceFingerprint: hash(changed) }))
    .toThrow("context_compaction_supervisor_receipt_source_changed");
  expect(() => check({ ...source, sourceRef: supervisorReceiptSourceRef("foreign-supervisor", f.executionId) }))
    .toThrow("context_compaction_supervisor_receipt_source_changed");
  expect(() => assertSupervisorReceiptCompactionSource({ source, head: f.head, scopeCall: f.call }))
    .toThrow("context_compaction_supervisor_receipt_owner_invalid");
  const changedHead = { ...f.head, state: { ...f.head.state,
    calls: f.head.state.calls.map((call) => call.callId === f.call.callId
      ? { ...call, objective: "Foreign objective" } : call),
  } };
  expect(() => assertSupervisorReceiptCompactionSource({ source, head: changedHead, scopeCall: f.root })).toThrow();
});

test("an unfinished direct child or Planner subtree cannot create a Supervisor receipt source", async () => {
  for (const throughPlanner of [false, true]) {
    const f = await mixedWorkerFixture(throughPlanner);
    const executionId = f.head.state.capabilityExecutions[0]!.executionId;
    const input = { head: f.head, consumerCallId: f.head.state.rootCallId!, executionId };
    expect(isSupervisorReceiptExecutionEligible(input)).toBe(false);
    expect(() => createSupervisorReceiptCompactionSource(input))
      .toThrow("context_compaction_supervisor_receipt_lineage_invalid");
    if (!throughPlanner) continue;
    await commit(f.ledger, { authority: "runtime", type: "return_child",
      callerCallId: f.call.parentCallId!, childCallId: f.call.callId,
      outcome: "completed", summary: "Worker completed; Planner remains active.",
    });
    expect(isSupervisorReceiptExecutionEligible({ ...input, head: f.ledger.current() })).toBe(false);
  }
});

async function fixture(throughPlanner: boolean) {
  const base = await mixedWorkerFixture(throughPlanner);
  await commit(base.ledger, { authority: "active_role", type: "begin_capability_execution",
    callId: base.call.callId, invocationAttempt: base.call.activationCount, capabilityId: "files.read",
    declaredEffect: "observation", intent: "Read fresh evidence.", controlsJson: '{"path":"fresh.txt"}',
    actionFingerprint: hash("fresh parent evidence"),
  });
  const executionId = base.ledger.current().state.capabilityExecutions.at(-1)!.executionId;
  await commit(base.ledger, { authority: "runtime", type: "settle_capability_execution",
    callId: base.call.callId, executionId, outcome: "succeeded", observedEffect: "observation",
    summary: freshSummary, outcomeFingerprint: "succeeded", referenceData: "HIDDEN_REFERENCE_DATA",
    exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
      ok: true, payload: { content: "HIDDEN_ADAPTER_BODY" } },
  });
  const exact = projectRequestToolResults({ ledger: base.ledger, head: base.ledger.current(),
    callId: base.call.callId, modelStep: "worker.decision" });
  const fullSource = createCapabilityResultCompactionSource(exact.results.find((result) => result.executionId === executionId)!);
  base.store.registerSources([fullSource]);
  await commit(base.ledger, { authority: "runtime", type: "return_child",
    callerCallId: base.call.parentCallId!, childCallId: base.call.callId,
    outcome: "completed", summary: "The requested target was inspected.",
  });
  if (throughPlanner) await commit(base.ledger, { authority: "runtime", type: "return_child",
    callerCallId: "call-1", childCallId: base.call.parentCallId!,
    outcome: "completed", summary: "Planned inspection completed.",
  });
  const head = base.ledger.current();
  const root = head.state.calls[0]!;
  const toolResults = projectRequestToolResults({ ledger: base.ledger, head,
    callId: root.callId, modelStep: "supervisor.response" });
  const counted = new Set<string>();
  const responseInputs: Array<readonly ChatMessage[]> = [];
  const responseCounts: Array<readonly ChatMessage[]> = [];
  const sentSourceRefs: string[] = [];
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    counted.add(JSON.stringify([input.modelStep, input.messages]));
    if (input.modelStep === "supervisor.response" && (input.messages as ChatMessage[]).length > 1)
      responseCounts.push(input.messages as readonly ChatMessage[]);
    const invocation = resolveModelInvocation(input);
    return { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(input.messages), "utf8") / 4),
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(counted.has(JSON.stringify([input.modelStep, input.messages]))).toBe(true);
    if (input.modelStep === "supervisor.response") {
      responseInputs.push(input.messages as readonly ChatMessage[]);
      return { text: "The inspected target is available.", meta: {} };
    }
    const message = (input.messages as readonly ChatMessage[]).find(({ role }) => role === "user")!;
    const envelope = JSON.parse(message.content);
    const source = envelope.baseCapsule.sourceSlice ?? envelope.baseCapsule.source;
    sentSourceRefs.push(source.sourceRef);
    return { text: compactSummary, meta: {} };
  });
  const original = createCompactionRequest({ requestId: head.state.requestId, prompt, store: base.store, invoke });
  const configuration = projectSuperCompactionConfiguration(original, original.executionPolicy.authority);
  const request = deriveTestRequestExecutionScope(original, {
    ...configuration,
    runnerConfig: { ...configuration.runnerConfig, steps: { ...configuration.runnerConfig.steps,
      "supervisor.response": { timeoutMs: 5_000 },
    } },
    modelGatewayClient: { ...original.modelGatewayClient, invoke, countInputTokens },
  });
  const scopeId = `role:supervisor:${root.callId}:continuation`;
  return { ...base, head, root, request, toolResults, fullSource, executionId, scopeId,
    responseInputs, responseCounts, sentSourceRefs,
    identity: { rootCallId: root.callId, callId: root.callId, parentCallId: null, depth: 0,
      invocationAttempt: root.activationCount },
    controller(evidence: NonNullable<ReturnType<typeof createSupervisorToolEvidence>>, current = request) {
      return createModelStepCompactionController(current, {
        call: { ...root, objective: prompt }, sourceRevision: head.revision,
        allowedConsumers: ["supervisor.decision", "supervisor.response"], consumer: "supervisor.response",
        supervisorToolEvidence: evidence, projectContinuation: projectSuperContinuation,
      }, generateSuperCompactionCandidate);
    },
  };
}
