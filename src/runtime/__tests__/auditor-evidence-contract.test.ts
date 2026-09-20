import { beforeEach, expect, test } from "vitest";
import { configureDebugLogger } from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
} from "../orchestration/role-calls/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import {
  bindAuditorEvidence,
  buildAuditorDecisionInput,
  encodeExecutionAgentAuditObjective,
  parseAuditorDecisionOutput,
  projectAuditorAssignment,
  projectAuditorInputState,
  projectAuditorWorkEvidence,
  projectAuditorEvidenceProjectionStatus,
  type AuditorAssignment,
  type AuditorDecision,
} from "../steps/auditor-decision/index.js";
import {
  settleAuditorAdvisory,
  failedAuditorAdvisory,
  readAuditorAdvisoryReceipt,
} from "../steps/auditor-decision/advisory-receipt.js";
import { parseAuditorEvidenceSelection } from "../steps/auditor-decision/evidence-selection.js";
import { createAuditorRunnerFixture } from "./support/auditor-runner-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));

const criteria = ["request_completion"];

async function commit(ledger: RoleCallLedger, command: RoleCallLedgerCommand) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`fixture_commit_failed:${result.code}`);
  return result;
}

async function appendWork(ledger: RoleCallLedger, length: number) {
  const head = ledger.current();
  const call = head.state.calls.find(
    (entry) => entry.callId === head.state.rootCallId,
  )!;
  const started = await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "fixture.observe",
    declaredEffect: "observation",
    intent: "Observe the exact record.",
    controlsJson: "{}",
  });
  if (started.effect.type !== "capability_execution_begun")
    throw new Error("fixture_execution_missing");
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: started.effect.executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "s".repeat(600),
    references: [{ kind: "tool_target", target: "path/" + "t".repeat(500) }],
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { exact: "x".repeat(length) },
    },
  });
}

async function createCase(lengths = [100, 100]) {
  const { request } = createAuditorRunnerFixture(() => {
    throw new Error("unexpected_model_call");
  });
  const ledger = createRoleCallLedger({
    requestId: request.requestId,
    policy: {
      authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      limits: {
        maxDepth: 4,
        maxCalls: 48,
        maxCapabilityExecutions: 96,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  for (const length of lengths) await appendWork(ledger, length);
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: encodeExecutionAgentAuditObjective(criteria),
  });
  const head = ledger.current();
  const call = head.state.calls.find(
    (entry) => entry.callId === head.state.activeCallId,
  )!;
  const assignment = projectAuditorAssignment(request, head, call);
  const source = projectAuditorWorkEvidence(head, "call-1");
  const ids = source.map((entry) => entry.executionId);
  return { request, ledger, call, assignment, source, ids };
}

function decision(
  assignment: AuditorAssignment,
  overrides: Partial<AuditorDecision> = {},
): AuditorDecision {
  return {
    auditId: assignment.auditId,
    verdict: "pass",
    criterionIds: criteria,
    gaps: [],
    neededEvidenceIds: assignment.selectedEvidenceIds,
    notNeededEvidenceIds: assignment.inventory
      .map((entry) => entry.executionId)
      .filter((id) => !assignment.selectedEvidenceIds.includes(id)),
    requestedEvidenceIds: [],
    ...overrides,
  };
}

function parse(
  assignment: AuditorAssignment,
  overrides: Partial<AuditorDecision> = {},
) {
  return parseAuditorDecisionOutput(
    JSON.stringify({ decision: decision(assignment, overrides) }),
    assignment,
  );
}

async function returnAudit(
  ledger: RoleCallLedger,
  assignment: AuditorAssignment,
  value: AuditorDecision,
) {
  const advisory = settleAuditorAdvisory(assignment, value);
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: assignment.callerCallId,
    childCallId: assignment.auditId,
    outcome: advisory.outcome,
    summary: advisory.summary,
  });
}

test("indexes every work item with declared previews and binds whole selected originals", async () => {
  const fixture = await createCase(Array.from({ length: 20 }, () => 4_000));
  const { assignment, source, ids, request } = fixture;
  expect(assignment.inventory).toHaveLength(20);
  expect(assignment.inventory[0]).toMatchObject({
    summaryPreview: { originalChars: 600, truncated: true },
    targetPreviews: [{ originalChars: 505, truncated: true }],
  });
  expect(JSON.stringify(assignment.inventory).length).toBeLessThan(20_000);
  expect(JSON.stringify(source).length).toBeGreaterThan(48_000);
  expect(assignment.evidence).toEqual([]);
  const selected = bindAuditorEvidence(assignment, source, [ids[0]!, ids[19]!]);
  expect(selected.evidence[0]!.adapterResult).toBe(source[0]!.adapterResult);
  expect(selected.evidence[1]!.adapterResult).toBe(source[19]!.adapterResult);
  expect(projectAuditorEvidenceProjectionStatus(selected)).toMatchObject({
    complete: true,
    selectedEvidenceCount: 2,
    availableEvidenceCount: 20,
  });
  const input = buildAuditorDecisionInput(request, selected);
  expect(input.context.compaction.applied).toBe(false);
  expect(
    input.context.messages.filter(({ content }) =>
      content.includes(request.prompt),
    ),
  ).toHaveLength(1);
});

test("binds large whole selections while rejecting unknown duplicate and stale proof", async () => {
  const { assignment, source, ids } = await createCase([
    49_000,
    ...Array<number>(17).fill(100),
  ]);
  const select = (selectedEvidenceIds: string[]) =>
    parseAuditorEvidenceSelection(
      JSON.stringify({
        decision: { auditId: assignment.auditId, selectedEvidenceIds },
      }),
      assignment,
    );
  expect(select(["foreign-execution"])).toMatchObject({
    ok: false,
    issues: [{ code: "auditor_evidence_id_unknown" }],
  });
  expect(select([ids[1]!, ids[1]!])).toMatchObject({
    ok: false,
    issues: [{ code: "auditor_evidence_ids_duplicate" }],
  });
  expect(bindAuditorEvidence(assignment, source, [ids[0]!]).evidence).toEqual([
    source[0],
  ]);
  expect(select(ids)).toMatchObject({ ok: true });
  expect(bindAuditorEvidence(assignment, source, ids).evidence).toEqual(source);
  expect(assignment.evidence).toEqual([]);
  const substituted = source.map((entry) => ({
    ...entry,
    summary: "z".repeat(600),
  }));
  expect(() => bindAuditorEvidence(assignment, substituted, [ids[1]!])).toThrow(
    "auditor_evidence_source_changed",
  );
});

test("requires full inventory classification and every needed original in the CURRENT bundle", async () => {
  const { assignment, source, ids } = await createCase();
  const bound = bindAuditorEvidence(assignment, source, [ids[0]!]);
  expect(parse(bound)).toMatchObject({
    ok: true,
    decision: { verdict: "pass" },
  });
  expect(
    parse(bound, { neededEvidenceIds: ids, notNeededEvidenceIds: [] }),
  ).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      {
        code: "auditor_pass_needed_evidence_missing",
        path: "decision.evidenceCoverage",
        message: expect.any(String),
      },
    ]),
  });
  expect(parse(bound, { notNeededEvidenceIds: [] })).toMatchObject({
    ok: false,
  });
  expect(
    parse(bound, { neededEvidenceIds: ids, notNeededEvidenceIds: [ids[0]!] }),
  ).toMatchObject({ ok: false });
  expect(
    parse(bound, { neededEvidenceIds: [], notNeededEvidenceIds: ids }),
  ).toMatchObject({ ok: false });
  expect(
    parse({ ...bound, evidence: [], omittedEvidenceCount: 1 }),
  ).toMatchObject({ ok: false });
});

test("needs_evidence permits a new complete bundle but rejects same and previously reviewed bundles", async () => {
  const { assignment, source, ids } = await createCase();
  const first = bindAuditorEvidence(assignment, source, [ids[0]!]);
  const needs = {
    verdict: "needs_evidence" as const,
    gaps: [
      {
        criterionId: criteria[0]!,
        description: "Inspect the second original alongside the first.",
      },
    ],
    neededEvidenceIds: ids,
    notNeededEvidenceIds: [],
    requestedEvidenceIds: ids,
  };
  expect(parse(first, needs)).toMatchObject({ ok: true });
  expect(
    parse(first, { ...needs, requestedEvidenceIds: [ids[0]!] }),
  ).toMatchObject({ ok: false });
  const receipt = JSON.parse(
    settleAuditorAdvisory(first, decision(first, needs)).summary,
  );
  const next = bindAuditorEvidence(
    {
      ...assignment,
      reviewedBundleFingerprints: [receipt.evidenceBinding.bundleFingerprint],
      reviewedEvidenceBundles: [[ids[0]!]],
    },
    source,
    ids,
  );
  expect(
    parse(next, { ...needs, requestedEvidenceIds: [ids[0]!] }),
  ).toMatchObject({ ok: false });
  expect(
    parse(next, { ...needs, requestedEvidenceIds: [...ids].reverse() }),
  ).toMatchObject({ ok: false });
});

test("a bound final audit closes identical work despite revisions; steering and actual work reopen it", async () => {
  const { ledger, assignment, source, ids } = await createCase();
  const bound = bindAuditorEvidence(assignment, source, [ids[0]!]);
  await returnAudit(ledger, bound, decision(bound));
  const closed = projectAuditorInputState(ledger.current(), "call-1", 0);
  expect(closed).toMatchObject({
    available: false,
    reason: "audit_finished_for_work",
  });
  expect(projectAuditorInputState(ledger.current(), "call-1", 1)).toMatchObject(
    { available: true, reason: "new_work" },
  );
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "planner",
    objective: "An advisory plan.",
  });
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: ledger.current().state.activeCallId!,
    outcome: "completed",
    summary: "Advice, not work.",
  });
  const afterAdvice = projectAuditorInputState(ledger.current(), "call-1", 0);
  expect(afterAdvice.workFingerprint).toBe(closed.workFingerprint);
  expect(afterAdvice.available).toBe(false);
  await appendWork(ledger, 100);
  expect(projectAuditorInputState(ledger.current(), "call-1", 0)).toMatchObject(
    { available: true, reason: "new_work" },
  );
});

test("new requested existing proof reopens without new work, while malformed binding cannot authorize continuation", async () => {
  const { ledger, assignment, source, ids } = await createCase();
  const first = bindAuditorEvidence(assignment, source, [ids[0]!]);
  await returnAudit(
    ledger,
    first,
    decision(first, {
      verdict: "needs_evidence",
      gaps: [
        {
          criterionId: criteria[0]!,
          description: "More original proof required.",
        },
      ],
      neededEvidenceIds: ids,
      notNeededEvidenceIds: [],
      requestedEvidenceIds: ids,
    }),
  );
  expect(projectAuditorInputState(ledger.current(), "call-1", 0)).toMatchObject(
    {
      available: true,
      reason: "auditor_requested_evidence",
      pendingEvidenceIds: ids,
      reviewedBundleCount: 1,
    },
  );
  const receipt = JSON.parse(
    settleAuditorAdvisory(first, decision(first)).summary,
  );
  receipt.evidenceBinding.bundleFingerprint = "forged";
  expect(readAuditorAdvisoryReceipt(JSON.stringify(receipt))).toBeUndefined();
  expect(
    readAuditorAdvisoryReceipt(
      JSON.stringify({ ...receipt, authority: "user" }),
    ),
  ).toBeUndefined();
});

test("runtime evidence admission failure settles a bound failure that closes the work snapshot", async () => {
  const { ledger, assignment } = await createCase([49_000]);
  const failed = failedAuditorAdvisory(
    assignment,
    "auditor_exact_context_exceeds_budget",
  );
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: assignment.auditId,
    outcome: failed.outcome,
    summary: failed.summary,
  });
  expect(projectAuditorInputState(ledger.current(), "call-1", 0)).toMatchObject(
    { available: false, reason: "audit_finished_for_work" },
  );
});
