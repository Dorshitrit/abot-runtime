import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import type { ModelGatewayClient } from "../ports.js";
import { createModelContextAssessment } from "../model/model-context-assessment.js";
import { resolveModelContextAdmission } from "../model/model-context-budget.js";
import { admitCompactedContext, requiresContextCompaction } from "../model/context-compaction-admission.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createSupervisorToolEvidence } from "../context/supervisor-tool-evidence.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { createRequestContextCompactionStore, createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/index.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import { buildSupervisorResponseInput, buildSupervisorMemoryAuthoringInput } from "../steps/supervisor-response/input.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { mixedWorkerFixture, commit } from "./support/super-mixed-compaction-fixture.js";
import { createCompactionRequest } from "./support/compaction-chunking-request-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

const prompt = "Inspect the target.";
const output = "EXACT_OBSERVATION_FROM_WORKER";
const supplemental = "Supplemental verification: the target still needs review.";
const privateContinuation = "PRIVATE_WORKER_CONTINUATION_DO_NOT_INHERIT";

test.each([false, true])("Supervisor inputs reuse passive completed Worker evidence through Planner=%s", async (throughPlanner) => {
  const f = await fixture(throughPlanner);
  const before = JSON.stringify(captureRequestContextCompaction(f.store));
  const canonicalView = JSON.stringify(f.toolResults);
  const evidence = createSupervisorToolEvidence(f.request, f.options)!;
  const messages = evidence.buildMessages();
  const serialized = JSON.stringify(messages);
  expect(serialized).toContain("COMPACTED_EXACT_OBSERVATION");
  expect(serialized).not.toContain(output);
  expect(serialized).not.toContain(privateContinuation);
  expect(serialized).toContain(supplemental);
  expect(serialized).not.toContain("adapterResult");
  expect(serialized).not.toContain("acceptedAction");
  const results = readResults(messages);
  expect(results.map((result) => result.executionId)).toEqual(f.toolResults.results.map((result) => result.executionId));
  expect(results.find((result) => result.executionId === f.aliasId)).not.toHaveProperty("summary");
  expect(results.find((result) => result.executionId === f.supplementalId)?.summary).toBe(supplemental);
  const sources = evidence.compaction.scanCompactionSources(messages, f.scopeId, new Map()).map(({ source }) => source);
  expect(sources.every((source) => source.sourceRef.startsWith("supervisor-receipt:"))).toBe(true);
  expect(sources.some((source) => source.content.includes(supplemental))).toBe(true);
  expect(sources.some((source) => source.content.includes(output))).toBe(false);
  expect(sources.some((source) => source.content.includes("COMPACTED_EXACT_OBSERVATION"))).toBe(false);

  const decision = buildSupervisorDecisionInput(f.request, {
    toolResults: f.toolResults, supervisorToolEvidence: evidence,
  }).context.messages;
  const response = buildSupervisorResponseInput(f.request, {
    toolResults: f.toolResults, supervisorToolEvidence: evidence, call: f.identity,
  }).context.messages;
  expect(evidenceMessages(decision)).toEqual(messages);
  expect(evidenceMessages(response)).toEqual(messages);
  expect(readResults(decision)).toEqual(readResults(response));
  expect(JSON.stringify(captureRequestContextCompaction(f.store))).toBe(before);
  expect(JSON.stringify(f.toolResults)).toBe(canonicalView);
});

test("restoring saved child evidence preserves its passive view without exposing its continuation", async () => {
  const f = await fixture(true);
  const saved = captureRequestContextCompaction(f.store);
  const restored = restoreRequestContextCompaction(JSON.parse(JSON.stringify(saved)));
  const original = createSupervisorToolEvidence(f.request, f.options)!.buildMessages();
  const request = { ...f.request, contextCompactionStore: restored };
  const rebuilt = createSupervisorToolEvidence(request, f.options)!.buildMessages();
  expect(rebuilt).toEqual(original);
  expect(JSON.stringify(rebuilt)).not.toContain(privateContinuation);
  expect(captureRequestContextCompaction(restored)).toEqual(saved);
});

test("fresh and uncovered receipts keep their original summary and expose no hidden adapter evidence", async () => {
  const f = await fixture();
  const noCheckpoint = createRequestContextCompactionStore();
  const evidence = createSupervisorToolEvidence({ ...f.request, contextCompactionStore: noCheckpoint }, f.options)!;
  const results = readResults(evidence.buildMessages());
  expect(results).toEqual(f.toolResults.results);
  expect(results.find((result) => result.executionId === f.aliasId)?.summary).toBe(output);
  const sources = evidence.compaction.scanCompactionSources(evidence.buildMessages(), f.scopeId, new Map());
  expect(sources).toHaveLength(results.length);
  expect(sources.every(({ source }) => !source.content.includes("adapterResult"))).toBe(true);
  const partial = createRequestContextCompactionStore();
  partial.registerSources(f.sources);
  partial.commit({ ...f.checkpoint, sourceDigests: f.checkpoint.sourceDigests.filter((digest) => digest.sourceRef !== f.aliasId) });
  const partiallyCovered = createSupervisorToolEvidence({ ...f.request, contextCompactionStore: partial }, f.options)!;
  expect(readResults(partiallyCovered.buildMessages()).find((result) => result.executionId === f.aliasId)?.summary).toBe(output);
});

test("foreign requests, stale views and invalid saved evidence do not authorize reuse", async () => {
  const f = await fixture();
  expect(() => createSupervisorToolEvidence({ ...f.request, requestId: "foreign-request" }, f.options))
    .toThrow();
  expect(() => createSupervisorToolEvidence(f.request, {
    ...f.options, toolResults: { ...f.toolResults, sourceRevision: f.head.revision - 1 },
  })).toThrow();
  const snapshot = captureRequestContextCompaction(f.store);
  const invalid = restoreRequestContextCompaction({
    ...snapshot, checkpoints: snapshot.checkpoints.map((checkpoint) => ({
      ...checkpoint, objectiveFingerprint: hash("foreign Worker objective"),
    })),
  });
  expect(() => createSupervisorToolEvidence({ ...f.request, contextCompactionStore: invalid }, f.options))
    .toThrow("context_compaction_checkpoint_objective_invalid");
});

test("missing store/head and uncompleted children keep the existing receipt projection", async () => {
  const f = await fixture();
  expect(createSupervisorToolEvidence({ ...f.request, contextCompactionStore: undefined }, f.options)).toBeUndefined();
  expect(createSupervisorToolEvidence(f.request, { ...f.options, head: undefined })).toBeUndefined();
  const active = await mixedWorkerFixture();
  const toolResults = projectRequestToolResults({ ledger: active.ledger, head: active.head,
    callId: active.head.state.rootCallId!, modelStep: "supervisor.decision" });
  const evidence = createSupervisorToolEvidence({ ...f.request, contextCompactionStore: active.store }, {
    head: active.head, callId: active.head.state.rootCallId!, toolResults,
  })!;
  expect(evidence).toBeUndefined();
});

test("memory authoring receives the same verified evidence as the response at the shared model step", async () => {
  const f = await fixture();
  const baseline = buildSupervisorMemoryAuthoringInput(f.request, { toolResults: f.toolResults, call: f.identity });
  const candidate = buildSupervisorMemoryAuthoringInput(f.request, {
    toolResults: f.toolResults, call: f.identity,
    supervisorToolEvidence: createSupervisorToolEvidence(f.request, f.options)!,
  });
  const response = buildSupervisorResponseInput(f.request, {
    toolResults: f.toolResults, call: f.identity,
    supervisorToolEvidence: createSupervisorToolEvidence(f.request, f.options)!,
  });
  expect(evidenceMessages(candidate.context.messages)).toEqual(evidenceMessages(response.context.messages));
  expect(evidenceMessages(candidate.context.messages)).not.toEqual(evidenceMessages(baseline.context.messages));
});


test("a root-owned exact result remains eligible alongside child evidence and repeated projection is stable", async () => {
  const f = await fixture();
  const root = f.head.state.calls[0]!;
  await commit(f.ledger, { authority: "active_role", type: "begin_capability_execution",
    callId: root.callId, invocationAttempt: root.activationCount, capabilityId: "root.observe",
    declaredEffect: "observation", intent: "Observe root evidence.", controlsJson: "{}",
    actionFingerprint: hash("root exact evidence"),
  });
  const executionId = f.ledger.current().state.capabilityExecutions.at(-1)!.executionId;
  await commit(f.ledger, { authority: "runtime", type: "settle_capability_execution",
    callId: root.callId, executionId, outcome: "succeeded", observedEffect: "observation",
    summary: "Root observed an independent result.", outcomeFingerprint: "succeeded",
    exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
      ok: true, payload: { content: "ROOT_RAW_EXACT_BODY" } },
  });
  const head = f.ledger.current();
  const toolResults = projectRequestToolResults({ ledger: f.ledger, head,
    callId: root.callId, modelStep: "supervisor.response" });
  const evidence = createSupervisorToolEvidence(f.request, { head, callId: root.callId, toolResults })!;
  const sources = evidence.compaction.scanCompactionSources(evidence.buildMessages(), f.scopeId, new Map())
    .map(({ source }) => source);
  expect(sources.some((source) => source.sourceRef === executionId)).toBe(true);
  expect(sources.some((source) => source.sourceRef.startsWith("supervisor-receipt:"))).toBe(true);
  const exact = createCapabilityResultCompactionSource(toolResults.results.find((result) => result.executionId === executionId)!);
  expect(sources.find((source) => source.sourceRef === executionId)).toEqual(exact);
  f.store.registerSources(sources);
  f.store.commit({ ...f.checkpoint, roleId: "supervisor", callId: root.callId,
    objectiveFingerprint: hash(prompt), scopeId: f.scopeId, sourceRevision: head.revision,
    allowedConsumers: ["supervisor.decision", "supervisor.response"],
    sourceDigests: sources.map(({ sourceRef, sourceFingerprint }) => ({ sourceRef, sourceFingerprint, digest: "PARENT_MIXED_EVIDENCE" })),
    continuation: createSuperContinuation("Parent inspection is complete."),
  });
  const controller = createModelStepCompactionController(f.request, {
    call: { ...root, objective: prompt }, sourceRevision: head.revision,
    allowedConsumers: ["supervisor.decision", "supervisor.response"], supervisorToolEvidence: evidence,
  });
  const projected = controller.project(evidence.buildMessages());
  expect(readResults(projected).map((result) => result.executionId))
    .toEqual(toolResults.results.map((result) => result.executionId));
  expect(JSON.stringify(projected)).not.toContain("ROOT_RAW_EXACT_BODY");
  expect(JSON.stringify(projected)).toContain("PARENT_MIXED_EVIDENCE");
  expect(JSON.stringify(projected)).toContain("COMPACTED_EXACT_OBSERVATION");
  expect(controller.project(projected)).toEqual(projected);
  expect(evidence.compaction.scanCompactionSources(projected, f.scopeId, new Map())).toEqual([]);
  expect(f.store.materializeSource(exact.sourceRef, exact.sourceFingerprint)).toEqual(exact);
});

test("verified child-only evidence above the trigger does not invoke the compactor again", async () => {
  const f = await fixture();
  const toolResults = { ...f.toolResults, results: f.toolResults.results.filter((result) => result.executionId === f.aliasId) };
  const evidence = createSupervisorToolEvidence(f.request, { ...f.options, toolResults })!;
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const invocation = resolveModelInvocation(input);
    return { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(input.messages), "utf8") / 4),
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens, source: "provider_input_token_count" };
  });
  const request = deriveTestRequestExecutionScope(f.request, {
    modelGatewayClient: { ...f.request.modelGatewayClient, countInputTokens },
  });
  const generate = vi.fn(async () => { throw new Error("verified_child_evidence_must_not_be_recompacted"); });
  const root = f.head.state.calls[0]!;
  const controller = createModelStepCompactionController(request, {
    call: { ...root, objective: prompt }, sourceRevision: f.head.revision,
    allowedConsumers: ["supervisor.decision", "supervisor.response"], supervisorToolEvidence: evidence,
  }, generate);
  const messages = controller.project([
    { role: "system", content: "policy ".repeat(6_700) },
    { role: "user", content: prompt }, ...evidence.buildMessages(),
  ]);
  const admission = resolveModelContextAdmission({ runnerConfig: request.runnerConfig,
    agentMode: request.agentMode, modelStep: "supervisor.response", modelPolicy: request.modelPolicy });
  const { assess } = createModelContextAssessment({ request, params: { modelStep: "supervisor.response", format: { type: "text" } },
    admission, assertCurrent() {} });
  const assessment = await assess(messages);
  expect(assessment.fits).toBe(true);
  expect(requiresContextCompaction(true, assessment)).toBe(true);
  expect(controller.hasExhaustedVerifiedCompactionSources?.(messages)).toBe(true);
  const before = captureRequestContextCompaction(f.store);
  const admitted = await admitCompactedContext({ messages, assessment, controller, assess,
    assertCurrent() {}, assertNotAborted() {}, abortSignal: request.abortSignal,
    identity: { requestId: request.requestId, invocationId: "supervisor-passive-digest", modelStep: "supervisor.response",
      profileId: "compact-test-profile", provider: "test", model: "compact-test-model" },
  });
  expect(admitted.messages).toEqual(messages);
  expect(generate).not.toHaveBeenCalled();
  expect(captureRequestContextCompaction(f.store)).toEqual(before);
});

function evidenceMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages.filter((message) => {
    try {
      const kind = JSON.parse(message.content).kind;
      return kind === "runtime_request_tool_results_v1" || kind === "runtime_semantic_compaction_checkpoint_v2";
    } catch { return false; }
  });
}

function readResults(messages: readonly ChatMessage[]): Array<Record<string, unknown>> {
  for (const message of messages) {
    try {
      const parsed = JSON.parse(message.content);
      if (parsed.kind === "runtime_request_tool_results_v1") return parsed.results;
    } catch { /* Ordinary instructions are not reference capsules. */ }
  }
  throw new Error("supervisor_tool_results_missing");
}

async function fixture(throughPlanner = false) {
  const base = await mixedWorkerFixture(throughPlanner);
  const ids: string[] = [];
  for (const summary of [output, supplemental]) {
    await commit(base.ledger, { authority: "active_role", type: "begin_capability_execution",
      callId: base.call.callId, invocationAttempt: base.ledger.current().state.calls.at(-1)!.activationCount, capabilityId: "read",
      declaredEffect: "observation", intent: "Read observed target.", controlsJson: "{}",
      actionFingerprint: hash(summary),
    });
    const executionId = base.ledger.current().state.capabilityExecutions.at(-1)!.executionId;
    ids.push(executionId);
    await commit(base.ledger, { authority: "runtime", type: "settle_capability_execution",
      callId: base.call.callId, executionId, outcome: "succeeded", observedEffect: "observation",
      summary, outcomeFingerprint: "succeeded", referenceData: output,
      exactResult: { kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
        result: { tool: "read", ok: true, producedNewInformation: true, output } },
    });
  }
  const workerHead = base.ledger.current();
  const exact = projectRequestToolResults({ ledger: base.ledger, head: workerHead,
    callId: base.call.callId, modelStep: "worker.decision" });
  const added = exact.results.filter((result) => ids.includes(result.executionId)).map(createCapabilityResultCompactionSource);
  const sources = [...base.sources, ...added];
  base.store.registerSources(added);
  const checkpoint = { ...base.checkpoint, sourceRevision: workerHead.revision,
    sourceDigests: [...base.checkpoint.sourceDigests, ...added.map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef, sourceFingerprint, digest: "COMPACTED_EXACT_OBSERVATION",
    }))],
    continuation: { ...base.checkpoint.continuation, nextStep: privateContinuation, currentState: privateContinuation },
  };
  base.store.commit(checkpoint);
  await commit(base.ledger, { authority: "runtime", type: "return_child",
    callerCallId: base.call.parentCallId!, childCallId: base.call.callId,
    outcome: "completed", summary: "Target inspection completed.",
  });
  if (throughPlanner) await commit(base.ledger, { authority: "runtime", type: "return_child",
    callerCallId: "call-1", childCallId: base.call.parentCallId!,
    outcome: "completed", summary: "Plan completed.",
  });
  const head = base.ledger.current();
  const root = head.state.calls[0]!;
  const toolResults = projectRequestToolResults({ ledger: base.ledger, head,
    callId: root.callId, modelStep: "supervisor.decision" });
  const request = createCompactionRequest({ requestId: head.state.requestId, prompt, store: base.store, invoke: vi.fn() });
  return { ...base, sources, checkpoint, head, toolResults, request,
    aliasId: ids[0]!, supplementalId: ids[1]!, scopeId: `role:supervisor:${root.callId}:continuation`,
    options: { head, callId: root.callId, toolResults },
    identity: { rootCallId: root.callId, callId: root.callId, parentCallId: null, depth: 0,
      invocationAttempt: root.activationCount },
  };
}
