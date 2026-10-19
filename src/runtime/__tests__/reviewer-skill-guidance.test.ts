import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { CapabilityAdapterResult } from "../orchestration/capability-adapters/index.js";
import { buildCoreSkillReadContextMessages, CORE_SKILL_READ_MESSAGE_KIND } from "../context/core-skill-read-context.js";
import { projectCanonicalCapabilityResultCompactionSources } from "../context/capability-result-compaction-source.js";
import { createSemanticCompactionSha256Fingerprint as hash } from "../context/semantic-compaction/contracts.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../orchestration/worker-capabilities/payload-contracts.js";
import { compactContinuation } from "./support/semantic-compaction-contract-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION } from "../steps/knowledge-skill-instructions.js";
import * as reviewerInput from "../steps/reviewer-decision/input.js";
import { projectReviewerReviewSnapshot } from "../steps/reviewer-decision/projection.js";
import { GENERIC_REVIEWER_EXECUTOR } from "../steps/reviewer-decision/run.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture, CORE_SKILL_DOCUMENT,
} from "./support/core-skill-read-context-fixture.js";

type Fixture = Awaited<ReturnType<typeof createCoreSkillContextFixture>>;
const body = "CAPTURED_PROCEDURE_BODY: perform only the assigned verification.";
const referenceDataBudget = { maxTokens: 100_000 };
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function capsule(messages: readonly ChatMessage[], kind: string): Record<string, any> {
  for (const { content } of messages) {
    try { const record = JSON.parse(content); if (record.kind === kind) return record; }
    catch { /* Not a JSON capsule. */ }
  }
  throw new Error(`missing_capsule:${kind}`);
}
function coreMessages(messages: readonly ChatMessage[]) {
  return messages.filter(({ content }) => content.includes(`"kind":"${CORE_SKILL_READ_MESSAGE_KIND}"`));
}
function registeredResult(tool = "abot_skills", ok = true): CapabilityAdapterResult {
  return { kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
    result: { tool, ok, producedNewInformation: ok, output: body } };
}
async function workerResult(f: Fixture, options: {
  capabilityId?: string; result?: CapabilityAdapterResult; failed?: boolean;
} = {}) {
  const worker = await f.open("worker");
  const started = await commitSkillFixture(f.ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: worker.callId,
    invocationAttempt: worker.activationCount, capabilityId: options.capabilityId ?? "read_skill",
    declaredEffect: "observation", intent: "Read the requested reference.", controlsJson: "{}",
  });
  if (started.effect.type !== "capability_execution_begun") throw new Error("missing_execution");
  await commitSkillFixture(f.ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: worker.callId,
    executionId: started.effect.executionId, outcome: options.failed ? "failed" : "succeeded",
    observedEffect: options.failed ? "none" : "observation", summary: "Read completed.",
    referenceData: body, exactResult: options.result ?? registeredResult(),
  });
  await f.finish();
  return started.effect.executionId;
}
async function openReviewer(f: Fixture, includeWorker = true) {
  await commitSkillFixture(f.ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "reviewer",
    objective: f.request.prompt,
    dependencyResultRefs: includeWorker ? f.ledger.current().state.results.map(({ resultRef }) => resultRef) : [],
  });
  const call = activeCoreSkillCall(f.ledger);
  const request = deriveTestRequestExecutionScope(f.request, {
    runnerConfig: { ...f.request.runnerConfig,
      steps: { ...f.request.runnerConfig.steps, "reviewer.decision": { timeoutMs: 20_000 } } },
    modelPolicy: { ...f.request.modelPolicy!, defaults: { profileId: "contract-model",
      steps: { "reviewer.decision": "reviewer.decision", "context.compact": "context.compact" } } },
  });
  const snapshot = projectReviewerReviewSnapshot({ requestId: request.requestId,
    requestObjective: request.prompt, ledger: f.ledger, call, referenceDataBudget });
  return { call, request, snapshot };
}
function gapDecision(messages: readonly ChatMessage[]) {
  const audit = capsule(messages, "runtime_reviewer_audit_v4");
  return { text: JSON.stringify({ decision: {
    action: "report_gaps", reviewScopeId: audit.auditScope.reviewScopeId,
    summary: "The supplied guidance does not establish task completion.",
    gaps: [{ kind: "missing_evidence", subjectRefs: [], factRefs: [], evidenceRefs: [],
      summary: "Completion has not been established." }],
    audit: {
      evidenceAssessments: audit.effects.map(({ evidenceRef }: { evidenceRef: string }) => ({
        evidenceRef, status: "does_not_establish", finding: "Guidance is not completion evidence.",
      })),
      completionAssessment: { status: "gap", evidenceRefs: [], finding: "Completion remains unverified." },
    },
  } }), meta: {} };
}

test("actual SUPER Reviewer receives the captured direct Skill once and reserves it in every budget pass", async () => {
  const f = await createCoreSkillContextFixture();
  await f.read([{ ...CORE_SKILL_DOCUMENT, content: body }]);
  const expected = buildCoreSkillReadContextMessages(f.ledger.current(), "delegate");
  const { call, request, snapshot } = await openReviewer(f);
  const before = JSON.stringify(f.ledger.current());
  const assessments = vi.spyOn(reviewerInput, "assessReviewerDecisionInputBudget");
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe("reviewer.decision");
    const messages = input.messages as readonly ChatMessage[];
    expect(coreMessages(messages)).toEqual(expected);
    expect(messages.filter(({ content }) => content.includes(body))).toHaveLength(1);
    expect(messages[0]!.content).toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
    expect(capsule(messages, "runtime_reviewer_audit_v4").completionTarget.text).toBe(request.prompt);
    expect(snapshot.evidence).toEqual([]);
    return gapDecision(messages);
  });
  await expect(GENERIC_REVIEWER_EXECUTOR.execute({ context: request, call, ledger: f.ledger,
    availableChildRoleIds: [] })).resolves.toMatchObject({ kind: "terminal", outcome: "completed",
    receipt: { verdict: "report_gaps" } });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(assessments.mock.calls.length).toBeGreaterThan(1);
  for (const [, options] of assessments.mock.calls) expect(options.skillGuidanceMessages).toEqual(expected);
  expect(JSON.stringify(f.ledger.current())).toBe(before);
});

test.each(["read_skill", "read_skills"])("marks canonical Worker %s in the existing evidence path without duplicating its body", async (capabilityId) => {
  const f = await createCoreSkillContextFixture();
  const executionId = await workerResult(f, { capabilityId });
  const { call, request, snapshot } = await openReviewer(f);
  expect(snapshot.evidence).toHaveLength(1);
  expect(snapshot.evidence[0]).toMatchObject({ kind: "skill_guidance", referenceData: body });
  expect(snapshot.evidence[0]!.evidenceRef).toContain(executionId);
  const tagged = reviewerInput.buildReviewerDecisionInput(request, { call, snapshot, referenceDataBudget });
  const neutralSnapshot = { ...snapshot, evidence: snapshot.evidence.map((entry) => ({
    ...entry, kind: "capability_execution",
  })) };
  const neutral = reviewerInput.buildReviewerDecisionInput(request, {
    call, snapshot: neutralSnapshot, referenceDataBudget,
  });
  const appendices = (messages: readonly ChatMessage[]) => messages
    .filter(({ content }) => content.includes("BEGIN BOUNDED EVIDENCE CONTENT"));
  expect(appendices(tagged.context.messages)).toEqual(appendices(neutral.context.messages));
  f.invoke.mockImplementation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    expect(coreMessages(messages)).toEqual([]);
    expect(messages[0]!.content).toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
    expect(messages.filter(({ content }) => content.includes(body))).toHaveLength(1);
    const audit = capsule(messages, "runtime_reviewer_audit_v4");
    expect(audit.effects).toEqual([expect.objectContaining({ purpose: "skill_guidance",
      presenceEffect: "procedural_guidance_not_completion_evidence" })]);
    const appendix = messages.find(({ content }) => content.includes("BEGIN BOUNDED EVIDENCE CONTENT"))!;
    expect(JSON.parse(appendix.content.split("\n")[0]!)).not.toHaveProperty("purpose");
    return gapDecision(messages);
  });
  await expect(GENERIC_REVIEWER_EXECUTOR.execute({ context: request, call, ledger: f.ledger,
    availableChildRoleIds: [] })).resolves.toMatchObject({ kind: "terminal", outcome: "completed" });
  expect(f.invoke).toHaveBeenCalledOnce();
});

test.each([
  { label: "list", capabilityId: "list_skills" },
  { label: "foreign operation", capabilityId: "read_document" },
  { label: "foreign tool", result: registeredResult("foreign_tool") },
  { label: "failed tool result", result: registeredResult("abot_skills", false) },
  { label: "failed execution", failed: true },
  { label: "generic imitation", result: { kind: "generic_capability_result_v1", authority: "capability_adapter",
    status: "executed", ok: true, payload: { tool: "abot_skills", content: body } } as CapabilityAdapterResult },
])("does not promote Worker $label to guidance", async (options) => {
  const f = await createCoreSkillContextFixture();
  await workerResult(f, options);
  const { call, request, snapshot } = await openReviewer(f);
  expect(snapshot.evidence[0]).toMatchObject({ kind: "capability_execution", referenceData: body });
  const input = reviewerInput.buildReviewerDecisionInput(request, { call, snapshot, referenceDataBudget });
  expect(input.context.messages[0]!.content).not.toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
  expect(capsule(input.context.messages, "runtime_reviewer_audit_v4").effects[0]).not.toHaveProperty("purpose");
  const appendix = input.context.messages.find(({ content }) => content.includes("BEGIN BOUNDED EVIDENCE CONTENT"))!;
  expect(JSON.parse(appendix.content.split("\n")[0]!)).not.toHaveProperty("purpose");
});

test("a Worker Skill outside the Reviewer's explicit dependencies remains out of context", async () => {
  const f = await createCoreSkillContextFixture();
  await workerResult(f);
  const { call, request, snapshot } = await openReviewer(f, false);
  expect(snapshot.evidence).toEqual([]);
  const input = reviewerInput.buildReviewerDecisionInput(request, { call, snapshot, referenceDataBudget });
  expect(JSON.stringify(input.context.messages)).not.toContain(body);
  expect(input.context.messages[0]!.content).not.toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
});

test.each(["list_skills", "failed_read"] as const)("direct %s does not supply guidance to the actual Reviewer", async (operation) => {
  const f = await createCoreSkillContextFixture();
  const root = activeCoreSkillCall(f.ledger);
  await commitSkillFixture(f.ledger, { authority: "runtime", type: "record_skill_read", callId: root.callId,
    invocationAttempt: root.activationCount, steeringVersion: 0,
    operation: operation === "list_skills" ? operation : "read_skills",
    selectors: operation === "list_skills" ? [] : ["missing"],
    result: operation === "list_skills" ? { outcome: "completed", skills: [] }
      : { outcome: "failed", errorCode: "knowledge_skill_not_found", skills: [] },
  });
  const { call, request } = await openReviewer(f);
  f.invoke.mockImplementation(async (input) => {
    const messages = input.messages as readonly ChatMessage[];
    expect(coreMessages(messages)).toEqual([]);
    expect(messages[0]!.content).not.toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
    return gapDecision(messages);
  });
  await expect(GENERIC_REVIEWER_EXECUTOR.execute({ context: request, call, ledger: f.ledger,
    availableChildRoleIds: [] })).resolves.toMatchObject({ kind: "terminal", outcome: "completed" });
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("guidance is accounted in assessment and final input while the empty option preserves context exactly", async () => {
  const f = await createCoreSkillContextFixture();
  await f.read([{ ...CORE_SKILL_DOCUMENT, content: "BUDGETED_SKILL_DETAIL ".repeat(600) }]);
  const skillGuidanceMessages = buildCoreSkillReadContextMessages(f.ledger.current(), "delegate");
  const { call, request, snapshot } = await openReviewer(f);
  const options = { call, snapshot, referenceDataBudget };
  const plain = reviewerInput.buildReviewerDecisionInput(request, options);
  const empty = reviewerInput.buildReviewerDecisionInput(request, { ...options, skillGuidanceMessages: [] });
  expect(empty.context).toEqual(plain.context);
  expect(empty.format).toEqual(plain.format);
  const withSkills = reviewerInput.buildReviewerDecisionInput(request, { ...options, skillGuidanceMessages });
  expect(withSkills.context.budget.estimatedInputTokens).toBeGreaterThan(plain.context.budget.estimatedInputTokens);
  expect(capsule(withSkills.context.messages, "runtime_reviewer_audit_v4"))
    .toEqual(capsule(plain.context.messages, "runtime_reviewer_audit_v4"));
  const baseBudget = reviewerInput.resolveReviewerDecisionContextBudget(request);
  const assessment = reviewerInput.assessReviewerDecisionInputBudget(request, {
    call, snapshot, skillGuidanceMessages, budget: baseBudget,
  });
  expect(assessment.budget.estimatedInputTokens).toBe(withSkills.context.budget.estimatedInputTokens);
  const constrained = { ...baseBudget,
    contextWindowTokens: plain.context.budget.estimatedInputTokens + 4_000 };
  expect(reviewerInput.assessReviewerDecisionInputBudget(request, { call, snapshot, budget: constrained }).fits).toBe(true);
  expect(reviewerInput.assessReviewerDecisionInputBudget(request, {
    call, snapshot, budget: constrained, skillGuidanceMessages,
  }).fits).toBe(false);
});


test("a verified Worker Skill digest keeps its guidance marker without restoring the raw document", async () => {
  const f = await createCoreSkillContextFixture();
  const executionId = await workerResult(f);
  const head = f.ledger.current();
  const worker = head.state.calls.find(({ roleId }) => roleId === "worker")!;
  const sources = projectCanonicalCapabilityResultCompactionSources({ head, callId: worker.callId });
  const source = sources.find(({ sourceRef }) => sourceRef === executionId)!;
  f.store.registerSources(sources);
  const digest = "PRESERVED_SKILL_METHOD: verify only the bounded assigned task.";
  f.store.commit({ kind: "runtime_semantic_compaction_checkpoint_v2",
    requestId: f.request.requestId, currentRequestFingerprint: hash(f.request.prompt),
    roleId: "worker", callId: worker.callId, objectiveFingerprint: hash(worker.objective!),
    contextLane: "role_continuation", scopeId: `worker:${worker.callId}:request-tool-results`,
    allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
    sourceRevision: head.revision,
    sourceDigests: [{ sourceRef: source.sourceRef, sourceFingerprint: source.sourceFingerprint, digest }],
    continuation: compactContinuation({ evidenceRefs: [source.sourceRef] }),
  });
  const { call, request } = await openReviewer(f);
  const snapshot = projectReviewerReviewSnapshot({ requestId: request.requestId,
    requestObjective: request.prompt, ledger: f.ledger, call, referenceDataBudget,
    contextCompactionStore: f.store });
  expect(snapshot.evidence[0]!.kind).toBe("skill_guidance");
  expect(JSON.parse(snapshot.evidence[0]!.referenceData!)).toMatchObject({
    kind: "runtime_reviewer_compacted_evidence_v1", source: { sourceRef: executionId, digest },
  });
  const input = reviewerInput.buildReviewerDecisionInput(request, { call, snapshot, referenceDataBudget });
  expect(input.context.messages[0]!.content).toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
  expect(JSON.stringify(input.context.messages)).toContain(digest);
  expect(JSON.stringify(input.context.messages)).not.toContain(body);
  expect(capsule(input.context.messages, "runtime_reviewer_audit_v4").effects[0])
    .toMatchObject({ purpose: "skill_guidance" });
});
