import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  createRoleCallReviewerVerdictReceipt,
  projectRoleCallDependencyResults,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "role-chain-receipt-characterization",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`role_call_commit_rejected:${result.code}`);
  return result.head;
}

async function createReviewedWork(): Promise<
  Readonly<{ ledger: RoleCallLedger; head: RoleCallLedgerHead }>
> {
  const ledger = createLedger();
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Produce one bounded result.",
  });
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: "call-2",
    outcome: "completed",
    summary: "The bounded result was produced.",
  });
  const reviewerHead = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: "Review the bounded result.",
    dependencyResultRefs: ["result-1"],
  });
  const head = await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: "call-3",
    outcome: "completed",
    summary: "One completion gap remains.",
    receipt: createRoleCallReviewerVerdictReceipt({
      reviewerCallId: "call-3",
      callerCallId: "call-1",
      reviewScopeId: `review:call-3:r${reviewerHead.revision}`,
      sourceRevision: reviewerHead.revision,
      verdict: "report_gaps",
      gaps: [
        {
          kind: "missing_evidence",
          subjectRefs: [],
          factRefs: [],
          evidenceRefs: [],
          summary: "The bounded result is not established.",
        },
      ],
    }),
  });
  return Object.freeze({ ledger, head });
}

describe("role-chain receipt characterization", () => {
  test("keeps the reviewed result target only on the Reviewer call frame", async () => {
    const { head } = await createReviewedWork();
    const reviewerCall = head.state.calls.find(
      ({ callId }) => callId === "call-3",
    );
    const reviewerResult = head.state.results.find(
      ({ resultRef }) => resultRef === "result-2",
    );

    expect(reviewerCall?.dependencyResultRefs).toEqual(["result-1"]);
    expect(reviewerResult?.receipt).toMatchObject({
      kind: "reviewer_verdict_v1",
      reviewerCallId: "call-3",
      verdict: "report_gaps",
    });
    expect(reviewerResult?.receipt).not.toHaveProperty("reviewedResultRefs");
  });

  test("preserves the Reviewer receipt in a remediation dependency projection", async () => {
    const { ledger } = await createReviewedWork();
    const plannerHead = await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Coordinate remediation of the reported gap.",
      dependencyResultRefs: ["result-2"],
    });
    const plannerCall = plannerHead.state.calls.find(
      ({ callId }) => callId === "call-4",
    );
    if (!plannerCall) throw new Error("planner_call_missing");

    const reviewerReceipt = plannerHead.state.results[1]?.receipt;
    expect(reviewerReceipt).toBeDefined();
    expect(projectRoleCallDependencyResults(plannerHead, plannerCall)).toEqual([
      {
        resultRef: "result-2",
        producerCallId: "call-3",
        roleId: "reviewer",
        outcome: "completed",
        summary: "One completion gap remains.",
        receipt: reviewerReceipt,
      },
    ]);
  });
});
