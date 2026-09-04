import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  createRoleCallReviewerVerdictReceipt,
  projectRoleChildReturnContext,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCallReviewerVerdictReceipt,
} from "../orchestration/role-calls/index.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutor,
} from "../orchestration/role-executors/index.js";
import type { RuntimeDelegateRoleId } from "../orchestration/roles.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { buildSupervisorContinuationMessages } from "../steps/supervisor-decision/resume.js";

const REVIEW_OBJECTIVE = "Review the supplied work against its requirements.";
type TestContext = Readonly<Record<string, never>>;

function createLedger(
  authority: ExecutionPolicyAuthoritySnapshot = SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "receipt-request",
    policy: {
      authority,
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

async function invokeRegisteredChild(
  roleId: RuntimeDelegateRoleId,
  execute: RoleExecutor<TestContext>["execute"],
  objective = REVIEW_OBJECTIVE,
) {
  const ledger = createLedger();
  const rooted = await commit(ledger, {
    authority: "runtime",
    type: "create_root",
  });
  const callerCall = rooted.state.calls[0];
  if (!callerCall) throw new Error("root_call_missing");
  const registry = createRoleExecutorRegistry<TestContext>([
    { roleId, execute },
  ]);
  const child = await registry.invokeChild({
    requestId: "receipt-request",
    context: {},
    callerCall,
    ledger,
    expectedHead: rooted,
    roleId,
    objective,
    turnCount: 1,
  });
  return Object.freeze({ child, ledger });
}

async function openChild(
  roleId: RuntimeDelegateRoleId,
  authority?: ExecutionPolicyAuthoritySnapshot,
): Promise<Readonly<{ ledger: RoleCallLedger; head: RoleCallLedgerHead }>> {
  const ledger = createLedger(authority);
  await commit(ledger, { authority: "runtime", type: "create_root" });
  const head = await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId,
    objective: REVIEW_OBJECTIVE,
  });
  return Object.freeze({ ledger, head });
}

function createPassReceipt(
  sourceRevision: number,
  overrides: Partial<
    Pick<
      RoleCallReviewerVerdictReceipt,
      "reviewerCallId" | "callerCallId" | "reviewScopeId"
    >
  > = {},
): RoleCallReviewerVerdictReceipt {
  const reviewerCallId = overrides.reviewerCallId ?? "call-2";
  return createRoleCallReviewerVerdictReceipt({
    reviewerCallId,
    callerCallId: overrides.callerCallId ?? "call-1",
    reviewScopeId:
      overrides.reviewScopeId ?? `review:${reviewerCallId}:r${sourceRevision}`,
    sourceRevision,
    verdict: "pass",
    gaps: [],
  });
}

async function expectReceiptRejected(
  ledger: RoleCallLedger,
  receipt: unknown,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  const before = ledger.current();
  const result = await ledger.apply({
    expectedHead: before,
    command: {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome,
      summary: "Human-readable reviewer result.",
      receipt,
    },
  });
  expect(result).toMatchObject({
    ok: false,
    status: "rejected",
    code: "invalid_command",
    head: { revision: before.revision },
  });
  expect(ledger.current()).toBe(before);
}

function expectReceiptDeepFrozen(
  receipt: RoleCallReviewerVerdictReceipt,
): void {
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.gaps)).toBe(true);
  for (const gap of receipt.gaps) {
    expect(Object.isFrozen(gap)).toBe(true);
    expect(Object.isFrozen(gap.subjectRefs)).toBe(true);
    expect(Object.isFrozen(gap.factRefs)).toBe(true);
    expect(Object.isFrozen(gap.evidenceRefs)).toBe(true);
  }
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("role-call reviewer verdict receipts", () => {
  test("round-trips a revision-bound Reviewer receipt through execution, ledger, and child context", async () => {
    const { child, ledger } = await invokeRegisteredChild(
      "reviewer",
      async ({ call, ledger: activeLedger }) => {
        if (!call.parentCallId) throw new Error("reviewer_caller_missing");
        const sourceRevision = activeLedger.current().revision;
        return {
          kind: "terminal",
          outcome: "completed",
          summary: "  Reviewer found one evidence gap.  ",
          receipt: createRoleCallReviewerVerdictReceipt({
            reviewerCallId: call.callId,
            callerCallId: call.parentCallId,
            reviewScopeId: `review:${call.callId}:r${sourceRevision}`,
            sourceRevision,
            verdict: "report_gaps",
            gaps: [
              {
                kind: "missing_evidence",
                subjectRefs: ["subject-1"],
                factRefs: ["fact-1"],
                evidenceRefs: [],
                summary: "No supporting artifact was supplied.",
              },
            ],
          }),
        };
      },
    );

    const executionReceipt = child.execution.receipt;
    if (executionReceipt?.kind !== "reviewer_verdict_v1") {
      throw new Error("execution_receipt_missing");
    }
    expect(child.execution.summary).toBe("Reviewer found one evidence gap.");
    expect(executionReceipt).toMatchObject({
      kind: "reviewer_verdict_v1",
      reviewerCallId: "call-2",
      callerCallId: "call-1",
      reviewScopeId: `review:call-2:r${child.returnCommit.previousHead.revision}`,
      sourceRevision: child.returnCommit.previousHead.revision,
      verdict: "report_gaps",
    });

    const stored = child.returnCommit.head.state.results.find(
      ({ resultRef }) => resultRef === child.returnCommit.effect.resultRef,
    );
    expect(stored).toMatchObject({
      producerCallId: "call-2",
      roleId: "reviewer",
      outcome: "completed",
      summary: "Reviewer found one evidence gap.",
      receipt: executionReceipt,
    });
    const projected = projectRoleChildReturnContext(ledger, child.returnCommit);
    expect(projected.completedChildren).toHaveLength(1);
    expect(projected.completedChildren[0]).toMatchObject({
      childCallId: "call-2",
      roleId: "reviewer",
      outcome: "completed",
      summary: "Reviewer found one evidence gap.",
      receipt: executionReceipt,
    });
    expectReceiptDeepFrozen(executionReceipt);
    expectReceiptDeepFrozen(stored?.receipt as RoleCallReviewerVerdictReceipt);
    expectReceiptDeepFrozen(
      projected.completedChildren[0]?.receipt as RoleCallReviewerVerdictReceipt,
    );
    const supervisorResult = JSON.parse(
      buildSupervisorContinuationMessages({
        resume: projected,
        currentCallId: "call-1",
        currentInvocationAttempt: 2,
      }).at(-1)!.content,
    ) as Record<string, unknown>;
    expect(supervisorResult).toMatchObject({
      summary: "Reviewer found one evidence gap.",
      reviewerVerdict: executionReceipt,
    });
  });

  test("rejects stale, mismatched, malformed, and extra-key receipts at the current head", async () => {
    const { ledger, head } = await openChild("reviewer");
    const staleRevision = head.revision - 1;
    const invalidReceipts: readonly unknown[] = [
      createPassReceipt(staleRevision),
      createPassReceipt(head.revision, { reviewerCallId: "call-999" }),
      createPassReceipt(head.revision, { callerCallId: "call-999" }),
      createPassReceipt(head.revision, { reviewScopeId: "review:wrong" }),
      { kind: "reviewer_verdict_v1" },
      { ...createPassReceipt(head.revision), unexpected: true },
      {
        ...createPassReceipt(head.revision),
        verdict: "report_gaps",
        gaps: Array.from({ length: 6 }, () => ({
          kind: "missing_evidence",
          subjectRefs: [],
          factRefs: [],
          evidenceRefs: [],
          summary: "Evidence is missing.",
        })),
      },
      {
        ...createPassReceipt(head.revision),
        verdict: "report_gaps",
        gaps: [
          {
            kind: "missing_evidence",
            subjectRefs: [],
            factRefs: [],
            evidenceRefs: [],
            summary: "x".repeat(225),
          },
        ],
      },
    ];
    for (const receipt of invalidReceipts) {
      await expectReceiptRejected(ledger, receipt);
    }
  });

  test("rejects receipts from the wrong producer, failed outcome, and execution-agent authority", async () => {
    const worker = await openChild("worker");
    await expectReceiptRejected(
      worker.ledger,
      createPassReceipt(worker.head.revision),
    );

    const failedReviewer = await openChild("reviewer");
    await expectReceiptRejected(
      failedReviewer.ledger,
      createPassReceipt(failedReviewer.head.revision),
      "failed",
    );

    const executionAgent = await openChild(
      "reviewer",
      EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
    );
    await expectReceiptRejected(
      executionAgent.ledger,
      createPassReceipt(executionAgent.head.revision),
    );
  });

  test("adds a runtime-owned receipt when an ordinary Worker returns", async () => {
    const { child, ledger } = await invokeRegisteredChild(
      "worker",
      async () => ({
        kind: "terminal",
        outcome: "completed",
        summary: "  Ordinary work completed.  ",
      }),
      "Perform ordinary work.",
    );
    const stored = child.returnCommit.head.state.results[0];
    const projected = projectRoleChildReturnContext(ledger, child.returnCommit)
      .completedChildren[0];
    const workReceipt = stored?.receipt;
    if (workReceipt?.kind !== "work_result_v1") {
      throw new Error("work_result_receipt_missing");
    }

    expect(child.execution).toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Ordinary work completed.",
    });
    expect(workReceipt).toMatchObject({
      kind: "work_result_v1",
      producerCallId: "call-2",
      callerCallId: "call-1",
    });
    expect(projected).toMatchObject({
      receipt: workReceipt,
      workLineage: {
        kind: "work_result_lineage_v1",
        lineageFingerprint: workReceipt.lineageFingerprint,
      },
    });
  });
});
