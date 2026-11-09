import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { buildCoreSkillReadContextMessages, CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { createCapabilityResultCompactionSource } from "../context/capability-result-compaction-source.js";
import { createSemanticCompactionSha256Fingerprint as hash, type RequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createSuperContinuation } from "../context/super-compaction/continuation.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/index.js";
import { createRoleCallLedger, createRoleCallReviewerVerdictReceipt } from "../orchestration/role-calls/index.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { projectReviewerReviewSnapshot } from "../steps/reviewer-decision/projection.js";
import { GENERIC_REVIEWER_EXECUTOR } from "../steps/reviewer-decision/run.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture, CORE_SKILL_DOCUMENT,
} from "./support/core-skill-read-context-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

test("two completed Workers sharing a root Skill project only their distinct execution digests", async () => {
  const f = await fixture();
  const saved = captureRequestContextCompaction(f.store);
  const before = JSON.stringify(f.ledger.current());
  expect(saved.sources.filter(({ sourceRef }) => sourceRef === f.skillSource.sourceRef)).toHaveLength(1);
  expect(saved.checkpoints.map(({ sourceDigests }) => sourceDigests[0]))
    .toEqual(f.workers.map(() => ({ sourceRef: f.skillSource.sourceRef,
      sourceFingerprint: f.skillSource.sourceFingerprint, digest: "SHARED_SKILL_GUIDANCE" })));
  const snapshot = f.project();
  expect(snapshot.evidence).toHaveLength(2);
  expect(compactedSources(snapshot.evidence)).toEqual(f.workers.map((worker, index) => ({
    sourceRef: worker.executionId, sourceFingerprint: worker.source.sourceFingerprint,
    digest: `WORKER_${index + 1}_OBSERVED_TARGET`,
  })));
  expect(JSON.stringify(snapshot.evidence)).not.toContain("SHARED_SKILL_GUIDANCE");
  expect(JSON.stringify(snapshot.evidence)).not.toContain(f.skillSource.sourceRef);
  expect(JSON.stringify(f.ledger.current())).toBe(before);
  expect(captureRequestContextCompaction(f.store)).toEqual(saved);
});

test("snapshot and approval restore retain both execution digests and the unchanged shared Skill source", async () => {
  const f = await fixture();
  const snapshot = JSON.parse(JSON.stringify(captureRequestContextCompaction(f.store)));
  const expected = f.project();
  const restored = restoreRequestContextCompaction(snapshot);
  expect(f.project(restored)).toEqual(expected);
  const ledgerCheckpoint = await parkApproval(f);
  const approval = restoreApprovalCompaction({
    snapshot, ledgerCheckpoint: JSON.parse(JSON.stringify(ledgerCheckpoint)),
    requestId: f.request.requestId, prompt: f.request.prompt, executionPolicy: f.request.executionPolicy,
  });
  for (const store of [restored, approval]) {
    expect(captureRequestContextCompaction(store)).toEqual(snapshot);
    expect(store.materializeSource(f.skillSource.sourceRef, f.skillSource.sourceFingerprint)).toEqual(f.skillSource);
  }
  const ledger = createRoleCallLedger({ requestId: f.request.requestId,
    policy: createRequestRoleCallPolicy(f.request.executionPolicy), checkpoint: ledgerCheckpoint });
  const pending = ledger.current().state.capabilityExecutions.at(-1)!;
  await commitSkillFixture(ledger, { authority: "runtime", type: "settle_capability_execution",
    callId: pending.callId, executionId: pending.executionId, outcome: "succeeded", observedEffect: "mutation",
    summary: "Approved save completed.", exactResult: { kind: "generic_capability_result_v1",
      authority: "capability_adapter", status: "executed", ok: true, payload: { saved: true } },
  });
  await commitSkillFixture(ledger, { authority: "runtime", type: "return_child", callerCallId: "call-1",
    childCallId: pending.callId, outcome: "completed", summary: "Approved save completed." });
  await commitSkillFixture(ledger, { authority: "active_role", type: "open_child",
    callerCallId: "call-1", roleId: "reviewer", objective: f.request.prompt,
    dependencyResultRefs: f.workers.map(({ resultRef }) => resultRef),
  });
  const resumed = projectReviewerReviewSnapshot({ requestId: f.request.requestId, requestObjective: f.request.prompt,
    ledger, call: activeCoreSkillCall(ledger), referenceDataBudget: { maxTokens: 100_000 },
    contextCompactionStore: approval, trace: false });
  expect(resumed.evidence).toEqual(expected.evidence);
});

test("the actual Reviewer reaches the model with execution evidence and a separate original Skill", async () => {
  const f = await fixture();
  const expectedGuidance = buildCoreSkillReadContextMessages(f.ledger.current(), "delegate");
  const counted: Array<readonly ChatMessage[]> = [];
  const countImplementation = f.countInputTokens.getMockImplementation()!;
  f.countInputTokens.mockImplementation(async (input) => {
    counted.push(input.messages as readonly ChatMessage[]);
    return countImplementation(input);
  });
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe("reviewer.decision");
    const messages = input.messages as readonly ChatMessage[];
    expect(counted.at(-1)).toEqual(messages);
    expect(messages.filter((message) => parse(message)?.kind === CORE_SKILL_READ_MESSAGE_KIND)).toEqual(expectedGuidance);
    expect(expectedGuidance).toHaveLength(1);
    const audit = messages.map(parse).find((record) => record?.kind === "runtime_reviewer_audit_v4")!;
    const evidenceMessages = messages.filter(({ content }) => content.startsWith('{"kind":"runtime_reviewer_evidence_v1"'));
    expect(evidenceMessages).toHaveLength(2);
    const serialized = JSON.stringify(evidenceMessages);
    expect(serialized).toContain("WORKER_1_OBSERVED_TARGET");
    expect(serialized).toContain("WORKER_2_OBSERVED_TARGET");
    expect(serialized).not.toContain("SHARED_SKILL_GUIDANCE");
    return { text: JSON.stringify({ decision: {
      action: "report_gaps", reviewScopeId: audit.auditScope.reviewScopeId,
      summary: "The observations do not yet establish completion.",
      gaps: [{ kind: "missing_evidence", subjectRefs: [], factRefs: [], evidenceRefs: [],
        summary: "Independent completion verification is missing." }],
      audit: {
        evidenceAssessments: audit.effects.map(({ evidenceRef }: { evidenceRef: string }) => ({
          evidenceRef, status: "does_not_establish", finding: "The observation alone does not prove completion.",
        })),
        completionAssessment: { status: "gap", evidenceRefs: [], finding: "Completion remains unverified." },
      },
    } }), meta: {} };
  });
  const request = deriveTestRequestExecutionScope(f.request, {
    runnerConfig: { ...f.request.runnerConfig, steps: { ...f.request.runnerConfig.steps,
      "reviewer.decision": { timeoutMs: 5_000 },
    } },
  });
  await expect(GENERIC_REVIEWER_EXECUTOR.execute({
    context: request, call: f.call, ledger: f.ledger, availableChildRoleIds: [],
  })).resolves.toMatchObject({ kind: "terminal", outcome: "completed", receipt: { verdict: "report_gaps" } });
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("execution evidence from a completed Worker outside the declared review scope stays excluded", async () => {
  const f = await fixture(3);
  const snapshot = f.project();
  expect(snapshot.evidence).toHaveLength(2);
  expect(compactedSources(snapshot.evidence).map(({ sourceRef }) => sourceRef))
    .toEqual(f.workers.slice(0, 2).map(({ executionId }) => executionId));
  expect(JSON.stringify(snapshot)).not.toContain(f.workers[2]!.executionId);
  expect(JSON.stringify(snapshot)).not.toContain("WORKER_3_OBSERVED_TARGET");
  expect(f.store.get(f.workers[2]!.checkpoint.scopeId)).toEqual(f.workers[2]!.checkpoint);
});

test.each(["skill", "execution"] as const)("missing or mismatched %s materialization is still rejected before selection", async (kind) => {
  const f = await fixture();
  const selected = kind === "skill" ? f.skillSource : f.workers[0]!.source;
  const missing: RequestContextCompactionStore = {
    ...f.store, materializeSource: (sourceRef, fingerprint) => sourceRef === selected.sourceRef
      ? undefined : f.store.materializeSource(sourceRef, fingerprint),
  };
  expect(() => f.project(missing)).toThrow("context_compaction_source_materialization_missing");
  const invalid: RequestContextCompactionStore = {
    ...f.store, findByCallIds: (callIds) => f.store.findByCallIds(callIds).map((checkpoint) => ({
      ...checkpoint, sourceDigests: checkpoint.sourceDigests.map((digest) =>
        digest.sourceRef === selected.sourceRef ? { ...digest, sourceFingerprint: hash("wrong bytes") } : digest),
    })),
  };
  expect(() => f.project(invalid)).toThrow("context_compaction_source_materialization_missing");
});

test("invalid shared Skill bytes are rejected even though Skill digests are not execution evidence", async () => {
  const f = await fixture();
  const saved = captureRequestContextCompaction(f.store);
  const content = f.skillSource.content.replace(CORE_SKILL_DOCUMENT.name, "Tampered root procedure");
  const changedSource = { ...f.skillSource, content, sourceFingerprint: hash(content) };
  const changed = {
    ...saved, sources: saved.sources.map((source) => source.sourceRef === f.skillSource.sourceRef ? changedSource : source),
    checkpoints: saved.checkpoints.map((checkpoint) => ({ ...checkpoint,
      sourceDigests: checkpoint.sourceDigests.map((digest) => digest.sourceRef === changedSource.sourceRef
        ? { ...digest, sourceFingerprint: changedSource.sourceFingerprint } : digest),
    })),
  };
  const restored = restoreRequestContextCompaction(changed);
  expect(() => f.project(restored)).toThrow("context_compaction_skill_read_source_changed");
  const ledgerCheckpoint = await parkApproval(f);
  expect(() => restoreApprovalCompaction({ snapshot: changed,
    ledgerCheckpoint, requestId: f.request.requestId,
    prompt: f.request.prompt, executionPolicy: f.request.executionPolicy,
  })).toThrow("context_compaction_snapshot_source_incompatible");
});

test("duplicate genuine execution digests remain rejected", async () => {
  const f = await fixture();
  const duplicated: RequestContextCompactionStore = {
    ...f.store, findByCallIds: (callIds) => {
      const first = f.store.findByCallIds(callIds)[0]!;
      return [first, first];
    },
  };
  expect(() => f.project(duplicated)).toThrow("reviewer_compacted_evidence_binding_invalid");
});

type ReviewerAudit = Readonly<{ kind: string; auditScope: { reviewScopeId: string };
  effects: readonly { evidenceRef: string }[] }>;

function parse(message: ChatMessage): ReviewerAudit | undefined {
  try { return JSON.parse(message.content); } catch { return undefined; }
}

function compactedSources(evidence: readonly { referenceData?: string }[]) {
  return evidence.map((item) => JSON.parse(item.referenceData!).source as {
    sourceRef: string; sourceFingerprint: string; digest: string;
  });
}

async function parkApproval(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = f.project();
  await commitSkillFixture(f.ledger, { authority: "runtime", type: "return_child",
    callerCallId: f.call.parentCallId, childCallId: f.call.callId, outcome: "completed", summary: "Review completed.",
    receipt: createRoleCallReviewerVerdictReceipt({ reviewerCallId: f.call.callId, callerCallId: snapshot.callerCallId,
      reviewScopeId: snapshot.reviewScopeId, sourceRevision: snapshot.sourceRevision, verdict: "pass", gaps: [] }),
  });
  const worker = await f.open("worker");
  await commitSkillFixture(f.ledger, { authority: "active_role", type: "begin_capability_execution",
    callId: worker.callId, invocationAttempt: worker.activationCount, capabilityId: "fixture.save",
    declaredEffect: "mutation", intent: "Save the approved result.", controlsJson: "{}" });
  return captureRoleCallLedgerCheckpoint(f.ledger);
}

async function fixture(workerCount = 2) {
  const f = await createCoreSkillContextFixture();
  await f.read();
  const skillMessage = buildCoreSkillReadContextMessages(f.ledger.current(), "delegate")[0]!;
  const content = JSON.stringify(skillMessage);
  const skillSource = { sourceRef: `core-skill-read:skill-read-1:${CORE_SKILL_DOCUMENT.skillId}`,
    content, sourceFingerprint: hash(content) };
  f.store.registerSources([skillSource]);
  const workers = [];
  for (let index = 0; index < workerCount; index++) {
    const worker = await f.open("worker");
    await commitSkillFixture(f.ledger, { authority: "active_role", type: "begin_capability_execution",
      callId: worker.callId, invocationAttempt: worker.activationCount, capabilityId: "fixture.inspect",
      declaredEffect: "observation", intent: "Inspect the assigned target.", controlsJson: "{}",
    });
    const executionId = f.ledger.current().state.capabilityExecutions.at(-1)!.executionId;
    await commitSkillFixture(f.ledger, { authority: "runtime", type: "settle_capability_execution",
      callId: worker.callId, executionId, outcome: "succeeded", observedEffect: "observation",
      summary: `Worker ${index + 1} observed the target.`, referenceData: `RAW_WORKER_${index + 1}_EVIDENCE`,
      exactResult: { kind: "generic_capability_result_v1", authority: "capability_adapter",
        status: "executed", ok: true, payload: { observed: `target-${index + 1}` } },
    });
    const head = f.ledger.current();
    const view = projectRequestToolResults({ ledger: f.ledger, head, callId: worker.callId, modelStep: "worker.decision" });
    const source = createCapabilityResultCompactionSource(view.results.find((result) => result.executionId === executionId)!);
    f.store.registerSources([source]);
    const checkpoint = {
      kind: "runtime_semantic_compaction_checkpoint_v2" as const, requestId: f.request.requestId,
      currentRequestFingerprint: hash(f.request.prompt), roleId: "worker", callId: worker.callId,
      objectiveFingerprint: hash(worker.objective!), contextLane: "role_continuation" as const,
      scopeId: `worker:${worker.callId}:request-tool-results`, sourceRevision: head.revision,
      allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
      sourceDigests: [
        { sourceRef: skillSource.sourceRef, sourceFingerprint: skillSource.sourceFingerprint, digest: "SHARED_SKILL_GUIDANCE" },
        { sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint, digest: `WORKER_${index + 1}_OBSERVED_TARGET` },
      ],
      continuation: createSuperContinuation(`Private Worker ${index + 1} handoff.`),
    };
    f.store.commit(checkpoint);
    const resume = await f.finish();
    workers.push({ callId: worker.callId, executionId, source, checkpoint, resultRef: resume.returnedResultRef });
  }
  await commitSkillFixture(f.ledger, { authority: "active_role", type: "open_child",
    callerCallId: "call-1", roleId: "reviewer", objective: f.request.prompt,
    dependencyResultRefs: workers.slice(0, 2).map(({ resultRef }) => resultRef),
  });
  const call = activeCoreSkillCall(f.ledger);
  return { ...f, call, workers, skillSource,
    project(store = f.store) {
      return projectReviewerReviewSnapshot({ requestId: f.request.requestId, requestObjective: f.request.prompt,
        ledger: f.ledger, call, referenceDataBudget: { maxTokens: 100_000 },
        contextCompactionStore: store, trace: false });
    },
  };
}
