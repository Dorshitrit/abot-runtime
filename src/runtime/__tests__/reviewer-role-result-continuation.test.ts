import { afterEach, beforeEach, expect, test } from "vitest";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectReviewerReviewSnapshot } from "../steps/reviewer-decision/projection.js";
import { normalizeReviewerReviewSnapshot } from "../steps/reviewer-decision/input.js";
import { projectReviewerModelContext } from "../steps/reviewer-decision/model-context.js";
import { createReviewerDecisionFormat } from "../steps/reviewer-decision/format.js";
import { parseReviewerDecisionOutput } from "../steps/reviewer-decision/parser.js";
import { REVIEWER_ITEM_SUMMARY_MAX_LENGTH, REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH } from "../steps/reviewer-decision/contracts.js";
import { commit } from "./support/super-mixed-compaction-fixture.js";

const REQUEST = "Audit the supplied report.";
const LONG_REPORT = "x".repeat(REVIEWER_ITEM_SUMMARY_MAX_LENGTH - 1) + " Exact passive observation. ".repeat(200) + "EXACT_REPORT_END";
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

async function fixture(summary: string, maxTokens = 10_000) {
  const ledger = createRoleCallLedger({ requestId: "reviewer-role-continuation", policy: { limits: {
    maxDepth: 12, maxCalls: 48, maxCapabilityExecutions: 96, maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536,
  } } });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, { authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker", objective: REQUEST });
  await commit(ledger, { authority: "runtime", type: "return_child", callerCallId: "call-1", childCallId: "call-2", outcome: "completed", summary });
  await commit(ledger, { authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "reviewer", objective: REQUEST, dependencyResultRefs: ["result-1"] });
  const call = ledger.current().state.calls.at(-1)!;
  const budget = { maxTokens, tokenEstimation: { asciiCharactersPerToken: 4 } };
  const snapshot = projectReviewerReviewSnapshot({ requestId: "reviewer-role-continuation", requestObjective: REQUEST,
    ledger, call, referenceDataBudget: budget, trace: false });
  return { ledger, call, budget, snapshot };
}

test.each([false, true])("long role report remains complete passive data after snapshot projection (serialized=%s)", async (serialized) => {
  const f = await fixture(LONG_REPORT);
  const normalized = normalizeReviewerReviewSnapshot(serialized ? JSON.parse(JSON.stringify(f.snapshot)) : f.snapshot, f.call, f.budget);
  expect(normalized).toEqual(f.snapshot);
  expect(normalized.projectionComplete).toBe(true);
  expect(normalized.evidence).toEqual([]);
  const projection = projectReviewerModelContext(normalized, f.call);
  const audit = JSON.parse(projection.prompt);
  expect(audit.effects).toEqual([]);
  expect(audit.claims).toEqual([]);
  const [dependency] = audit.dependencySubjects;
  expect(dependency).toMatchObject({ resultRef: "result-1", producerCallId: "call-2", roleId: "worker" });
  expect(dependency.summary.length).toBeLessThanOrEqual(REVIEWER_ITEM_SUMMARY_MAX_LENGTH);
  expect(projection.referenceMessages).toHaveLength(1);
  const continuation = JSON.parse(projection.referenceMessages[0]!.content);
  expect(continuation).toMatchObject({ kind: "runtime_reviewer_role_result_continuation_v1",
    authority: "canonical_role_call_dependency_result", resultRef: dependency.resultRef,
    subjectRefs: [dependency.subjectRef], retainedSummaryCharacters: dependency.summary.length });
  expect(dependency.summary + continuation.continuation).toBe(LONG_REPORT);
  expect(f.ledger.current().state.results[0]!.summary).toBe(LONG_REPORT);
});

test("short role results keep their original topology", async () => {
  const f = await fixture("A short report.");
  expect(f.snapshot.projectionComplete).toBe(true);
  expect(f.snapshot.facts[0]).not.toHaveProperty("summaryContinuation");
  expect(projectReviewerModelContext(f.snapshot, f.call).referenceMessages).toEqual([]);
});

test.each(["budget", "characters"] as const)("an omitted role-report continuation remains ineligible for pass (%s)", async (limit) => {
  const summary = limit === "characters"
    ? "x".repeat(REVIEWER_ITEM_SUMMARY_MAX_LENGTH + REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH + 1) : LONG_REPORT;
  const f = await fixture(summary, limit === "budget" ? 1 : 100_000);
  expect(f.snapshot.projectionComplete).toBe(false);
  expect(f.snapshot.facts[0]).not.toHaveProperty("summaryContinuation");
  expect(projectReviewerModelContext(f.snapshot, f.call).referenceMessages).toEqual([]);
  expect(JSON.stringify(createReviewerDecisionFormat(f.snapshot).schema)).not.toContain('"const":"pass"');
  const parsed = parseReviewerDecisionOutput(JSON.stringify({ decision: { action: "pass", reviewScopeId: f.snapshot.reviewScopeId,
    summary: "Complete", gaps: [], audit: { evidenceAssessments: [], completionAssessment: { status: "satisfied", evidenceRefs: [], finding: "Complete" } } } }), { snapshot: f.snapshot });
  expect(parsed).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "reviewer_pass_evidence_incomplete" })]) });
  expect(f.ledger.current().state.results[0]!.summary).toBe(summary);
});

test("snapshot normalization keeps continuation scope and aggregate budget checks", async () => {
  const f = await fixture(LONG_REPORT);
  expect(() => normalizeReviewerReviewSnapshot(f.snapshot, { ...f.call, callId: "stale-reviewer" }, f.budget)).toThrow("reviewer_snapshot_invalid");
  expect(() => normalizeReviewerReviewSnapshot(f.snapshot, f.call, { maxTokens: 1 })).toThrow("reviewer_snapshot_invalid");
  for (const fact of [
    { ...f.snapshot.facts[0], kind: "unrelated_fact" },
    { ...f.snapshot.facts[0], subjectRefs: ["call:foreign"] },
    { ...f.snapshot.facts[0], summaryContinuation: "x".repeat(REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH + 1) },
  ]) expect(() => normalizeReviewerReviewSnapshot({ ...f.snapshot, facts: [fact] }, f.call, f.budget)).toThrow("reviewer_snapshot_invalid");
});
