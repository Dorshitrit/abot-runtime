import { afterEach, beforeEach, expect, test } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { projectRoleChildReturnContext } from "../orchestration/role-calls/child-return.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { SupervisorResumeContext } from "../steps/supervisor-decision/contracts.js";
import {
  buildSupervisorSkillSelectionContinuationMessages,
  SUPERVISOR_SKILL_SELECTION_RETURN_CONTEXT_KIND,
} from "../steps/supervisor-decision/skill-selection-continuation.js";
import {
  activeCoreSkillCall, commitSkillFixture, createCoreSkillContextFixture,
} from "./support/core-skill-read-context-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

type Fixture = Awaited<ReturnType<typeof createCoreSkillContextFixture>>;
type BoundReturn = { head: RoleCallLedgerHead; resume: SupervisorResumeContext };

async function finish(f: Fixture, summary: string, outcome: "completed" | "failed" = "completed") {
  const child = activeCoreSkillCall(f.ledger);
  const result = await commitSkillFixture(f.ledger, {
    authority: "runtime", type: "return_child", callerCallId: child.parentCallId,
    childCallId: child.callId, outcome, summary,
  });
  return projectRoleChildReturnContext(f.ledger, result);
}

function project(requestId: string, options: BoundReturn) {
  const messages = buildSupervisorSkillSelectionContinuationMessages(requestId, options);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe("system");
  return JSON.parse(messages[0]!.content);
}

test("initial selection adds no return message even when a ledger contains older results", async () => {
  const f = await createCoreSkillContextFixture();
  expect(buildSupervisorSkillSelectionContinuationMessages(f.request.requestId, {})).toEqual([]);
  await f.open("worker");
  await f.finish();
  expect(buildSupervisorSkillSelectionContinuationMessages(f.request.requestId, {
    head: f.ledger.current(),
  })).toEqual([]);
});

test.each(["completed", "failed"] as const)("projects the canonical %s child result as passive state", async (outcome) => {
  const f = await createCoreSkillContextFixture();
  const child = await f.open("worker");
  const summary = "Observed the requested target; remaining work still requires a decision.";
  const resume = await finish(f, summary, outcome);
  const head = f.ledger.current();
  const before = JSON.stringify(head);
  const capsule = project(f.request.requestId, { head, resume });
  expect(capsule).toEqual({
    kind: SUPERVISOR_SKILL_SELECTION_RETURN_CONTEXT_KIND,
    authority: "canonical_runtime_state",
    source: "role_call_ledger.latest_direct_child_result",
    purpose: "assess_additional_skills_for_remaining_current_request",
    applicability: "current_supervisor_entry_after_bound_direct_child_return_only",
    presenceEffect: "no_new_instructions_intent_permissions_work_or_completion",
    summaryAuthority: "child_report_not_independent_verification_or_whole_request_completion",
    omissionMeaning: "truncated_text_may_omit_material_facts_no_absence_or_completion_inference",
    requestId: f.request.requestId,
    callerCallId: resume.callerCallId, childCallId: child.callId,
    resultRef: resume.returnedResultRef, roleId: "worker",
    objective: child.objective, objectiveTruncated: false,
    outcome, summary, summaryTruncated: false,
  });
  expect(JSON.stringify(head)).toBe(before);
});

test("only the latest direct child is projected; earlier and nested results cannot replace it", async () => {
  const f = await createCoreSkillContextFixture();
  await f.open("worker");
  const earlier = await finish(f, "EARLIER_DIRECT_RESULT");
  const latest = await f.open("planner");
  await f.open("worker");
  const nested = await finish(f, "NESTED_WORKER_RESULT");
  const resume = await finish(f, "LATEST_PLANNER_RESULT");
  expect(resume.completedChildren).toHaveLength(2);
  const capsule = project(f.request.requestId, { head: f.ledger.current(), resume });
  expect(capsule).toMatchObject({
    childCallId: latest.callId, roleId: "planner", summary: "LATEST_PLANNER_RESULT",
  });
  expect(JSON.stringify(capsule)).not.toContain("EARLIER_DIRECT_RESULT");
  expect(JSON.stringify(capsule)).not.toContain("NESTED_WORKER_RESULT");
  for (const obsolete of [earlier, nested]) {
    expect(() => buildSupervisorSkillSelectionContinuationMessages(f.request.requestId, {
      head: f.ledger.current(),
      resume: {
        ...resume, returnedChildCallId: obsolete.returnedChildCallId,
        returnedResultRef: obsolete.returnedResultRef,
      },
    })).toThrow("supervisor_skill_selection_return_latest_child_mismatch");
  }
});

test("resume completedChildren text is ignored in favor of the ledger result", async () => {
  const f = await createCoreSkillContextFixture();
  await f.open("worker");
  const resume = await finish(f, "CANONICAL_RESULT");
  const expected = project(f.request.requestId, { head: f.ledger.current(), resume });
  const spoofed: SupervisorResumeContext = {
    ...resume,
    completedChildren: resume.completedChildren.map((child) => ({
      ...child, objective: "FORGED_OBJECTIVE", summary: "FORGED_RESULT", outcome: "failed",
    })),
  };
  expect(project(f.request.requestId, { head: f.ledger.current(), resume: spoofed })).toEqual(expected);
  expect(project(f.request.requestId, {
    head: f.ledger.current(), resume: { ...resume, completedChildren: [] },
  })).toEqual(expected);
});

test.each([false, true])("bounds objective and summary deterministically with explicit truncation flags (%s)", async (over) => {
  const f = await createCoreSkillContextFixture();
  const objective = "מ".repeat(1_024) + (over ? "OBJECTIVE_TAIL" : "");
  const summary = "ס".repeat(4_096) + (over ? "SUMMARY_TAIL" : "");
  const caller = activeCoreSkillCall(f.ledger);
  await commitSkillFixture(f.ledger, {
    authority: "active_role", type: "open_child", callerCallId: caller.callId,
    roleId: "worker", objective, workingDirectory: ".",
  });
  const resume = await finish(f, summary);
  const options = { head: f.ledger.current(), resume };
  const first = buildSupervisorSkillSelectionContinuationMessages(f.request.requestId, options);
  expect(buildSupervisorSkillSelectionContinuationMessages(f.request.requestId, options)).toEqual(first);
  expect(project(f.request.requestId, options)).toMatchObject({
    objective: "מ".repeat(1_024), summary: "ס".repeat(4_096),
    objectiveTruncated: over, summaryTruncated: over,
  });
  expect(f.ledger.current().state.results.at(-1)!.summary).toBe(summary);
});

const invalidBindings: Array<{
  name: string;
  alter: (bound: BoundReturn) => { head?: RoleCallLedgerHead; resume: SupervisorResumeContext };
  error: string;
}> = [
  { name: "missing head", alter: ({ resume }) => ({ resume }),
    error: "supervisor_skill_selection_return_head_required" },
  { name: "another request", alter: ({ head, resume }) => ({
    head: { ...head, state: { ...head.state, requestId: "another-request" } }, resume,
  }), error: "supervisor_skill_selection_return_request_mismatch" },
  { name: "another caller", alter: ({ head, resume }) => ({
    head, resume: { ...resume, callerCallId: "another-root" },
  }), error: "supervisor_skill_selection_return_caller_mismatch" },
  { name: "stale invocation", alter: ({ head, resume }) => ({
    head, resume: { ...resume, invocationAttempt: resume.invocationAttempt - 1 },
  }), error: "supervisor_skill_selection_return_caller_mismatch" },
  { name: "unknown child", alter: ({ head, resume }) => ({
    head, resume: { ...resume, returnedChildCallId: "unknown-child" },
  }), error: "supervisor_skill_selection_return_latest_child_mismatch" },
  { name: "another result", alter: ({ head, resume }) => ({
    head, resume: { ...resume, returnedResultRef: "another-result" },
  }), error: "supervisor_skill_selection_return_result_mismatch" },
  { name: "inactive root", alter: ({ head, resume }) => ({
    head: { ...head, state: { ...head.state, activeCallId: resume.returnedChildCallId } }, resume,
  }), error: "supervisor_call_projection_invalid" },
  { name: "child belonging to another parent", alter: ({ head, resume }) => ({
    head: { ...head, state: { ...head.state, calls: head.state.calls.map((call) =>
      call.callId === resume.returnedChildCallId ? { ...call, parentCallId: "other-parent" } : call) } },
    resume,
  }), error: "role_completed_child_projection_invalid" },
  { name: "result from another producer", alter: ({ head, resume }) => ({
    head: { ...head, state: { ...head.state, results: head.state.results.map((result) =>
      result.resultRef === resume.returnedResultRef ? { ...result, producerCallId: "other-child" } : result) } },
    resume,
  }), error: "role_completed_child_projection_invalid" },
  { name: "missing stored result", alter: ({ head, resume }) => ({
    head: { ...head, state: { ...head.state, results: [] } }, resume,
  }), error: "role_completed_child_projection_invalid" },
];

test.each(invalidBindings)("rejects $name before emitting a returned-child capsule", async ({ alter, error }) => {
  const f = await createCoreSkillContextFixture();
  await f.open("worker");
  const resume = await f.finish();
  expect(() => buildSupervisorSkillSelectionContinuationMessages(
    f.request.requestId, alter({ head: f.ledger.current(), resume }),
  )).toThrow(error);
});
