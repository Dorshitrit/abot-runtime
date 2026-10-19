import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { CapabilityAdapterResult } from "../orchestration/capability-adapters/index.js";
import type { RoleCallLedger, RoleCallLedgerCommand } from "../orchestration/role-calls/index.js";
import { captureRoleCallLedgerCheckpoint, restoreRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createRequestRoleCallPolicy } from "../request/role-call-policy.js";
import { KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION } from "../steps/knowledge-skill-instructions.js";
import {
  bindAuditorEvidence, buildAuditorDecisionInput, encodeExecutionAgentAuditObjective,
  parseAuditorDecisionOutput, projectAuditorAssignment, projectAuditorWorkEvidence,
} from "../steps/auditor-decision/index.js";
import { EXECUTION_AGENT_AUDITOR_EXECUTOR } from "../steps/auditor-decision/run.js";
import type { AuditorAssignment, AuditorCapabilityEvidence } from "../steps/auditor-decision/contracts.js";
import type { AuditorEvidenceRepresentation } from "../steps/auditor-decision/evidence-representation.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  activeSkillCall, createKnowledgeSkillsCompactionFixture,
  SKILL_COMPACTION_FACT, SKILL_COMPACTION_PADDING,
  UNREQUESTED_SKILL_CONTENT,
} from "./support/knowledge-skills-compaction-fixture.js";

const INVENTORY = "runtime_execution_agent_auditor_inventory_v1";
const EVIDENCE = "runtime_execution_agent_auditor_evidence_v1";
const ASSIGNMENT = "runtime_execution_agent_auditor_assignment_v1";
const criteria = ["request_completion"];
type SkillGuidance = {
  authority: string;
  presenceEffect: string;
  executionIds: string[];
  sources: AuditorEvidenceRepresentation[];
};
type InventoryCapsule = { skillGuidance?: SkillGuidance };

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

function capsule<T>(messages: readonly ChatMessage[], kind: string): T {
  for (const { content } of messages) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(content) as Record<string, unknown>; }
    catch { continue; }
    if (value.kind === kind) return value as T;
  }
  throw new Error(`missing_capsule:${kind}`);
}

async function commit(ledger: RoleCallLedger, command: RoleCallLedgerCommand) {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!result.ok) throw new Error(`fixture_commit_failed:${result.code}`);
  return result;
}

function registeredResult(tool = "abot_skills", ok = true): CapabilityAdapterResult {
  return {
    kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
    result: { tool, ok, producedNewInformation: ok,
      output: JSON.stringify({ skillId: "fixture-skill", name: "Fixture Skill", content: "PROCEDURE_BODY" }) },
  };
}

async function appendResult(
  ledger: RoleCallLedger,
  capabilityId = "fixture.observe",
  exactResult: CapabilityAdapterResult = {
    kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
    ok: true, payload: { observation: "OBSERVED_PRODUCT_FACT" },
  },
  outcome: "succeeded" | "failed" = "succeeded",
) {
  const call = activeSkillCall(ledger);
  const started = await commit(ledger, {
    authority: "active_role", type: "begin_capability_execution", callId: call.callId,
    invocationAttempt: call.activationCount, capabilityId, declaredEffect: "observation",
    intent: "Capture the requested record.", controlsJson: "{}",
  });
  if (started.effect.type !== "capability_execution_begun") throw new Error("missing_execution");
  await commit(ledger, {
    authority: "runtime", type: "settle_capability_execution", callId: call.callId,
    executionId: started.effect.executionId, outcome,
    observedEffect: outcome === "succeeded" ? "observation" : "none",
    summary: "Captured the record.", exactResult,
  });
  return started.effect.executionId;
}

async function openAuditor(ledger: RoleCallLedger) {
  await commit(ledger, {
    authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "reviewer",
    objective: encodeExecutionAgentAuditObjective(criteria),
  });
  return activeSkillCall(ledger);
}

async function createCase(readSkill = true) {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  if (readSkill) await f.readSkill();
  const proofId = await appendResult(f.ledger);
  const call = await openAuditor(f.ledger);
  const assignment = projectAuditorAssignment(f.request, f.ledger.current(), call);
  const source = projectAuditorWorkEvidence(f.ledger.current(), "call-1");
  return { ...f, call, assignment, source, proofId };
}

function pass(assignment: AuditorAssignment, neededIds: readonly string[]) {
  return {
    auditId: assignment.auditId, verdict: "pass", criterionIds: criteria, gaps: [],
    neededEvidenceIds: neededIds,
    notNeededEvidenceIds: assignment.inventory.map(({ executionId }) => executionId)
      .filter((id) => !neededIds.includes(id)),
    requestedEvidenceIds: [],
  };
}

test("canonical Skill guidance survives independent evidence selection without becoming proof or intent", async () => {
  const f = await createCase();
  const before = JSON.stringify(f.ledger.current());
  const skill = f.source.find(({ capabilityId }) => capabilityId === "read_skill")!;
  expect(f.assignment.skillReadEvidence).toEqual([skill]);
  const bound = bindAuditorEvidence(f.assignment, f.source, [f.proofId]);
  for (const phase of ["selection", "review"] as const) {
    const input = buildAuditorDecisionInput(f.request, bound, phase);
    const guidance = capsule<InventoryCapsule>(input.context.messages, INVENTORY).skillGuidance!;
    expect(guidance).toMatchObject({
      authority: "core_skill_read_results",
      presenceEffect: "procedural_guidance_not_user_intent_criteria_or_completion_evidence",
      executionIds: [skill.executionId],
    });
    expect(guidance.sources[0]!.adapterResult).toEqual(skill.adapterResult);
    expect(JSON.stringify(input.context.messages)).toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
    expect(JSON.stringify(input.context.messages)).not.toContain(UNREQUESTED_SKILL_CONTENT);
    const target = capsule<{ target: string; criteria: unknown }>(input.context.messages, ASSIGNMENT);
    expect(JSON.parse(target.target).currentRequest).toBe(f.request.prompt);
    expect(target.criteria).toEqual(f.assignment.criteria);
  }
  const review = buildAuditorDecisionInput(f.request, bound, "review");
  const proof = capsule<{ evidence: AuditorCapabilityEvidence[] }>(review.context.messages, EVIDENCE);
  expect(proof.evidence.map(({ executionId }) => executionId)).toEqual([f.proofId]);
  expect(parseAuditorDecisionOutput(JSON.stringify({ decision: pass(bound, [f.proofId]) }), bound))
    .toMatchObject({ ok: true, decision: { notNeededEvidenceIds: [skill.executionId] } });
  expect(JSON.stringify(f.ledger.current())).toBe(before);
  expect(f.execute).toHaveBeenCalledOnce();
});

test("a selected Skill has one body while remaining identified as guidance", async () => {
  const f = await createCase();
  const skill = f.assignment.skillReadEvidence![0]!;
  const bound = bindAuditorEvidence(f.assignment, f.source, [skill.executionId, f.proofId]);
  const input = buildAuditorDecisionInput(f.request, bound, "review");
  expect(capsule<InventoryCapsule>(input.context.messages, INVENTORY).skillGuidance)
    .toMatchObject({ executionIds: [skill.executionId], sources: [] });
  const proof = capsule<{ evidence: AuditorCapabilityEvidence[] }>(input.context.messages, EVIDENCE);
  const selected = proof.evidence.find(({ executionId }) => executionId === skill.executionId)!;
  expect(selected.adapterResult).toEqual(skill.adapterResult);
  expect(input.context.messages.filter(({ content }) => content.includes(SKILL_COMPACTION_PADDING)))
    .toHaveLength(1);
});

test.each([
  { label: "list", capabilityId: "list_skills", result: registeredResult() },
  { label: "create", capabilityId: "create_skill", result: registeredResult() },
  { label: "update", capabilityId: "update_skill", result: registeredResult() },
  { label: "foreign tool", capabilityId: "read_skill", result: registeredResult("foreign_tool") },
  { label: "foreign capability", capabilityId: "foreign_read", result: registeredResult() },
  { label: "failed output", capabilityId: "read_skill", result: registeredResult("abot_skills", false) },
  { label: "failed execution", capabilityId: "read_skill", result: registeredResult(), outcome: "failed" as const },
  { label: "generic imitation", capabilityId: "read_skill", result: {
    kind: "generic_capability_result_v1", authority: "capability_adapter", status: "executed",
    ok: true, payload: { tool: "abot_skills", output: "PROCEDURE_BODY" },
  } as CapabilityAdapterResult },
])("does not promote $label to Skill guidance", async ({ capabilityId, result, outcome }) => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await appendResult(f.ledger, capabilityId, result, outcome);
  const call = await openAuditor(f.ledger);
  const assignment = projectAuditorAssignment(f.request, f.ledger.current(), call);
  expect(assignment.skillReadEvidence ?? []).toEqual([]);
  const input = buildAuditorDecisionInput(f.request, assignment, "selection");
  expect(capsule<InventoryCapsule>(input.context.messages, INVENTORY)).not.toHaveProperty("skillGuidance");
  expect(JSON.stringify(input.context.messages)).not.toContain(KNOWLEDGE_SKILL_GUIDANCE_INSTRUCTION);
  expect(JSON.stringify(input.context.messages)).not.toContain("PROCEDURE_BODY");
});

test("multiple-read results qualify, but another caller's captured read does not", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await appendResult(f.ledger, "read_skills", registeredResult());
  const call = await openAuditor(f.ledger);
  const head = f.ledger.current();
  expect(projectAuditorAssignment(f.request, head, call).skillReadEvidence).toHaveLength(1);
  const foreignHead = {
    ...head, state: { ...head.state, capabilityExecutions: head.state.capabilityExecutions
      .map((execution) => ({ ...execution, callId: "another-caller" })) },
  };
  expect(projectAuditorAssignment(f.request, foreignHead, call).skillReadEvidence ?? []).toEqual([]);
});

test("requests without Skill reads preserve their input when the optional guidance is empty", async () => {
  const f = await createCase(false);
  expect(f.assignment).not.toHaveProperty("skillReadEvidence");
  for (const phase of ["selection", "review"] as const) {
    const bound = bindAuditorEvidence(f.assignment, f.source, [f.proofId]);
    const original = buildAuditorDecisionInput(f.request, bound, phase);
    const empty = buildAuditorDecisionInput(f.request, { ...bound, skillReadEvidence: [] }, phase);
    expect(empty.context.messages).toEqual(original.context.messages);
    expect(capsule<InventoryCapsule>(original.context.messages, INVENTORY)).not.toHaveProperty("skillGuidance");
  }
});

test("Skill guidance uses existing budget accounting without changing selected evidence counts", async () => {
  const f = await createCase();
  const bound = bindAuditorEvidence(f.assignment, f.source, [f.proofId]);
  const withGuidance = buildAuditorDecisionInput(f.request, bound, "review");
  const withoutGuidance = buildAuditorDecisionInput(f.request, { ...bound, skillReadEvidence: [] }, "review");
  expect(withGuidance.context.budget.parts.referenceInputTokens)
    .toBeGreaterThan(withoutGuidance.context.budget.parts.referenceInputTokens);
  expect(withGuidance.context.budget.estimatedInputTokens)
    .toBeGreaterThan(withoutGuidance.context.budget.estimatedInputTokens);
  expect(withGuidance.selectedEvidenceChars).toBe(withoutGuidance.selectedEvidenceChars);
  expect(withGuidance.context.compaction.applied).toBe(false);
  expect(withGuidance.assignment.selectedEvidenceIds).toEqual([f.proofId]);
});

test("serialized EA compaction and ledger restore deliver only the bound Skill digest to both Auditor phases", async () => {
  const f = await createKnowledgeSkillsCompactionFixture("execution-agent-v1");
  await f.readSkill();
  f.forceCompaction();
  await f.runDecision();
  const proofId = await appendResult(f.ledger);
  await f.parkForApproval();
  const snapshot = captureRequestContextCompaction(f.request.contextCompactionStore!);
  const snapshotBytes = JSON.stringify(snapshot);
  const ledgerSnapshot = captureRoleCallLedgerCheckpoint(f.ledger);
  const restoredStore = restoreRequestContextCompaction(JSON.parse(snapshotBytes));
  const restoredLedger = restoreRoleCallLedgerCheckpoint(JSON.parse(JSON.stringify(ledgerSnapshot)), {
    requestId: f.request.requestId, policy: createRequestRoleCallPolicy(f.request.executionPolicy),
  });
  expect(JSON.stringify(restoredLedger.current().state)).toBe(JSON.stringify(ledgerSnapshot.state));
  const parked = restoredLedger.current().state.capabilityExecutions.find(({ status }) => status === "running")!;
  await commit(restoredLedger, {
    authority: "runtime", type: "settle_capability_execution", callId: parked.callId,
    executionId: parked.executionId, outcome: "failed", observedEffect: "none", summary: "Fixture write declined.",
    exactResult: {
      kind: "runtime_capability_rejection_v1", authority: "runtime", status: "rejected",
      stage: "before_external_execution", code: "fixture_declined", message: "Fixture write declined.",
    },
  });
  await openAuditor(restoredLedger);
  const ledgerBytes = JSON.stringify(restoredLedger.current());
  const request = deriveTestRequestExecutionScope(f.request, { contextCompactionStore: restoredStore });
  const call = activeSkillCall(restoredLedger);
  const assignment = projectAuditorAssignment(request, restoredLedger.current(), call);
  const source = projectAuditorWorkEvidence(restoredLedger.current(), "call-1");
  const bound = bindAuditorEvidence(assignment, source, [proofId]);
  const skill = assignment.skillReadEvidence![0]!;
  for (const phase of ["selection", "review"] as const) {
    const input = buildAuditorDecisionInput(request, bound, phase);
    const guidance = capsule<InventoryCapsule>(input.context.messages, INVENTORY).skillGuidance!;
    expect(guidance.sources[0]!.compactedSourceEvidence).toMatchObject({
      executionId: skill.executionId, digest: SKILL_COMPACTION_FACT,
      sourceRef: `tool-result:${skill.executionId}`,
    });
    expect(guidance.sources[0]).not.toHaveProperty("adapterResult");
    expect(input.reusedCompactedSourceCount).toBe(1);
    expect(JSON.stringify(input.context.messages)).not.toContain(SKILL_COMPACTION_PADDING);
    expect(JSON.stringify(input.context.messages)).not.toContain("Explain the documented procedure.");
  }
  expect(JSON.stringify(restoredStore.snapshot!())).toBe(snapshotBytes);
  expect(JSON.stringify(restoredLedger.current())).toBe(ledgerBytes);
  expect(f.execute).toHaveBeenCalledOnce();
});

test("Auditor executor supplies an unselected Skill to selection and review without rereading it", async () => {
  const f = await createCase();
  const skillId = f.assignment.skillReadEvidence![0]!.executionId;
  const phases: string[] = [];
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe("auditor.decision");
    const messages = input.messages as readonly ChatMessage[];
    const assignment = capsule<{ phase: string; auditId: string }>(messages, ASSIGNMENT);
    phases.push(assignment.phase);
    const guidance = capsule<InventoryCapsule>(messages, INVENTORY).skillGuidance!;
    expect(guidance.executionIds).toEqual([skillId]);
    expect(JSON.stringify(guidance.sources)).toContain(SKILL_COMPACTION_PADDING);
    const decision = assignment.phase === "selection"
      ? { auditId: assignment.auditId, selectedEvidenceIds: [f.proofId] }
      : pass(f.assignment, [f.proofId]);
    return { text: JSON.stringify({ decision }), meta: {} };
  });
  const request = deriveTestRequestExecutionScope(f.request, {
    runnerConfig: { ...f.request.runnerConfig,
      steps: { ...f.request.runnerConfig.steps, "auditor.decision": { timeoutMs: 20_000 } } },
  });
  const result = await EXECUTION_AGENT_AUDITOR_EXECUTOR.execute({
    context: request, call: f.call, ledger: f.ledger, availableChildRoleIds: [],
  });
  expect(result).toMatchObject({ kind: "terminal", outcome: "completed" });
  if (result.kind !== "terminal") throw new Error("audit_not_terminal");
  expect(JSON.parse(result.summary)).toMatchObject({
    verdict: "pass", notNeededEvidenceIds: [skillId],
    evidenceBinding: { selectedEvidenceIds: [f.proofId] },
  });
  expect(phases).toEqual(["selection", "review"]);
  expect(f.execute).toHaveBeenCalledOnce();
});

test("mandatory Skill guidance over the reserved budget fails before selection without compaction or rereading", async () => {
  const f = await createCase();
  const before = JSON.stringify(f.request.contextCompactionStore!.snapshot!());
  f.forceCompaction();
  const request = deriveTestRequestExecutionScope(f.request, {
    runnerConfig: { ...f.request.runnerConfig,
      steps: { ...f.request.runnerConfig.steps, "auditor.decision": { timeoutMs: 20_000 } } },
  });
  const result = await EXECUTION_AGENT_AUDITOR_EXECUTOR.execute({
    context: request, call: f.call, ledger: f.ledger, availableChildRoleIds: [],
  });
  expect(result).toMatchObject({ kind: "terminal", outcome: "failed" });
  if (result.kind !== "terminal") throw new Error("audit_not_terminal");
  expect(JSON.parse(result.summary)).toMatchObject({
    verdict: "failed", reason: "auditor_exact_context_exceeds_budget",
    evidenceBinding: { selectedEvidenceIds: [] },
  });
  expect(f.measuredInputs).toEqual([{ step: "auditor.decision", inputTokens: 63_500 }]);
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.modelInputs).toEqual([]);
  expect(JSON.stringify(f.request.contextCompactionStore!.snapshot!())).toBe(before);
  expect(f.execute).toHaveBeenCalledOnce();
});
