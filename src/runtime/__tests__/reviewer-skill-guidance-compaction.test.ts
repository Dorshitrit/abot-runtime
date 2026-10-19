import { afterEach, beforeEach, expect, test } from "vitest";
import { buildCoreSkillReadContextMessages, CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { superCompactionFailureOwner } from "../context/super-compaction-failure-owner.js";
import { assertCoreSkillReadSource } from "../context/semantic-compaction/core-skill-read-source.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { captureRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { assertSuperCompactionCheckpointIntegrity } from "../context/semantic-compaction/super-source-integrity.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRoleCallReviewerVerdictReceipt } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { buildReviewerDecisionInput } from "../steps/reviewer-decision/input.js";
import { projectReviewerReviewSnapshot } from "../steps/reviewer-decision/projection.js";
import {
  activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture, CORE_SKILL_DOCUMENT, CORE_SKILL_PADDING,
} from "./support/core-skill-read-context-fixture.js";
import { COMPACTION_FACT } from "./support/semantic-compaction-contract-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("Reviewer compaction and approval restore preserve the original root Skill identity", async () => {
  const f = await createCoreSkillContextFixture();
  await f.read();
  const skillGuidanceMessages = buildCoreSkillReadContextMessages(f.ledger.current(), "delegate");
  await commitSkillFixture(f.ledger, { authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "reviewer", objective: f.request.prompt });
  const call = activeCoreSkillCall(f.ledger);
  const head = f.ledger.current();
  const referenceDataBudget = { maxTokens: 100_000 };
  const snapshot = projectReviewerReviewSnapshot({ requestId: f.request.requestId,
    requestObjective: f.request.prompt, ledger: f.ledger, call, referenceDataBudget });
  const input = buildReviewerDecisionInput(f.request, { call, snapshot, referenceDataBudget, skillGuidanceMessages });
  const scopeId = `role:reviewer:${call.callId}:continuation`;
  const controller = createModelStepCompactionController(f.request, {
    consumer: "reviewer.decision", call, sourceRevision: head.revision,
    scopeId, allowedConsumers: ["reviewer.decision"],
    superFailureOwner: superCompactionFailureOwner(f.request.executionPolicy.authority, {
      requestId: f.request.requestId, callId: call.callId, parentCallId: call.parentCallId,
      contractId: "delegated.reviewer", invocationAttempt: call.activationCount,
      sourceRevision: head.revision, modelStep: "reviewer.decision", phase: "compaction", scopeId,
    }),
  });
  const prepared = await controller.getStages()[0]!.prepare(input.context.messages);
  if (prepared.kind !== "prepared") throw new Error("expected_skill_compaction");
  await prepared.preparation.commit();
  const captured = captureRequestContextCompaction(f.store);
  const originalContent = JSON.stringify(skillGuidanceMessages[0]);
  const sourceRef = `core-skill-read:skill-read-1:${CORE_SKILL_DOCUMENT.skillId}`;
  expect(captured.sources).toContainEqual({ sourceRef, content: originalContent,
    sourceFingerprint: hash(originalContent) });
  const checkpoint = captured.checkpoints.find(({ callId }) => callId === call.callId)!;
  expect(checkpoint).toMatchObject({ roleId: "reviewer", scopeId, allowedConsumers: ["reviewer.decision"] });
  expect(checkpoint.sourceDigests.map(({ sourceRef }) => sourceRef)).toContain(sourceRef);
  expect(() => assertSuperCompactionCheckpointIntegrity({ requestId: f.request.requestId,
    prompt: f.request.prompt, head, store: f.store, checkpoint })).not.toThrow();
  const projected = controller.project(input.context.messages);
  expect(JSON.stringify(projected)).toContain(COMPACTION_FACT);
  expect(JSON.stringify(projected)).not.toContain(CORE_SKILL_PADDING);
  expect(projected.filter(({ content }) => content.includes(`"kind":"${CORE_SKILL_READ_MESSAGE_KIND}"`))).toEqual([]);

  await commitSkillFixture(f.ledger, { authority: "runtime", type: "return_child",
    callerCallId: call.parentCallId, childCallId: call.callId, outcome: "completed", summary: "Review complete.",
    receipt: createRoleCallReviewerVerdictReceipt({ reviewerCallId: call.callId, callerCallId: snapshot.callerCallId,
      reviewScopeId: snapshot.reviewScopeId, sourceRevision: snapshot.sourceRevision, verdict: "pass", gaps: [] }),
  });
  const worker = await f.open("worker");
  await commitSkillFixture(f.ledger, { authority: "active_role", type: "begin_capability_execution",
    callId: worker.callId, invocationAttempt: worker.activationCount, capabilityId: "fixture.save",
    declaredEffect: "mutation", intent: "Save the requested result.", controlsJson: "{}" });
  const restored = restoreApprovalCompaction({ snapshot: JSON.parse(JSON.stringify(captured)),
    ledgerCheckpoint: JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(f.ledger))),
    requestId: f.request.requestId, prompt: f.request.prompt, executionPolicy: f.request.executionPolicy });
  expect(restored.snapshot!()).toEqual(captured);
  expect(() => assertSuperCompactionCheckpointIntegrity({ requestId: f.request.requestId,
    prompt: f.request.prompt, head, store: restored, checkpoint })).not.toThrow();
  const changed = JSON.parse(JSON.stringify(captured));
  const stored = changed.sources.find((entry: { sourceRef: string }) => entry.sourceRef === sourceRef);
  stored.content = stored.content.replace(CORE_SKILL_DOCUMENT.name, "Tampered procedure");
  stored.sourceFingerprint = hash(stored.content);
  expect(() => restoreApprovalCompaction({ snapshot: changed,
    ledgerCheckpoint: captureRoleCallLedgerCheckpoint(f.ledger), requestId: f.request.requestId,
    prompt: f.request.prompt, executionPolicy: f.request.executionPolicy }))
    .toThrow("context_compaction_snapshot_source_incompatible");
});

test("Reviewer consumption rejects an unrelated scope and changed captured Skill bytes", async () => {
  const f = await createCoreSkillContextFixture();
  await f.read();
  const message = buildCoreSkillReadContextMessages(f.ledger.current(), "delegate")[0]!;
  await commitSkillFixture(f.ledger, { authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "reviewer", objective: f.request.prompt });
  const call = activeCoreSkillCall(f.ledger);
  const content = JSON.stringify(message);
  const source = { sourceRef: `core-skill-read:skill-read-1:${CORE_SKILL_DOCUMENT.skillId}`,
    content, sourceFingerprint: hash(content) };
  const params = { source, record: JSON.parse(message.content), head: f.ledger.current(), scopeCall: call };
  expect(() => assertCoreSkillReadSource(params)).not.toThrow();
  expect(() => assertCoreSkillReadSource({ ...params, scopeCall: { ...call, parentCallId: "foreign-call" } }))
    .toThrow("context_compaction_skill_read_source_changed");
  const changedMessage = { ...message, content: message.content.replace(CORE_SKILL_DOCUMENT.name, "Changed name") };
  const changedContent = JSON.stringify(changedMessage);
  expect(() => assertCoreSkillReadSource({ ...params, record: JSON.parse(changedMessage.content),
    source: { ...source, content: changedContent, sourceFingerprint: hash(changedContent) } }))
    .toThrow("context_compaction_skill_read_source_changed");
});

test.each(["list_skills", "failed_read"] as const)("Reviewer may not restore direct %s discovery as guidance", async (operation) => {
  const f = await createCoreSkillContextFixture();
  const root = activeCoreSkillCall(f.ledger);
  await commitSkillFixture(f.ledger, { authority: "runtime", type: "record_skill_read", callId: root.callId,
    invocationAttempt: root.activationCount, steeringVersion: 0,
    operation: operation === "list_skills" ? operation : "read_skills",
    selectors: operation === "list_skills" ? [] : ["missing"],
    result: operation === "list_skills" ? { outcome: "completed", skills: [] }
      : { outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [] },
  });
  const message = buildCoreSkillReadContextMessages(f.ledger.current())[0]!;
  expect(buildCoreSkillReadContextMessages(f.ledger.current(), "delegate")).toEqual([]);
  await commitSkillFixture(f.ledger, { authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "reviewer", objective: f.request.prompt });
  const content = JSON.stringify(message);
  expect(() => assertCoreSkillReadSource({
    source: { sourceRef: "core-skill-read:skill-read-1", content, sourceFingerprint: hash(content) },
    record: JSON.parse(message.content), head: f.ledger.current(), scopeCall: activeCoreSkillCall(f.ledger),
  })).toThrow("context_compaction_skill_read_source_changed");
});
