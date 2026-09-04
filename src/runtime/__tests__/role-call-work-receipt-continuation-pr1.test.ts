import { describe, expect, test } from "vitest";

import {
  createRoleCallReviewerVerdictReceipt,
  type CompletedRoleChildResult,
  type RoleChildReturnContext,
} from "../orchestration/role-calls/index.js";
import { buildPlannerChildContinuationPart } from "../steps/planner-decision/resume.js";
import { buildSupervisorContinuationPart } from "../steps/supervisor-decision/resume.js";

const WORK_RECEIPT = Object.freeze({
  kind: "work_result_v1" as const,
  producerCallId: "call-worker",
  callerCallId: "call-root",
  sourceRevision: 7,
  lineageFingerprint:
    "sha256:9bb9e472c2faeb388cd84776cfa66fa6a4f0602776aa994ee85b95cef409b1b6",
});

const WORK_LINEAGE = Object.freeze({
  kind: "work_result_lineage_v1" as const,
  lineageFingerprint: WORK_RECEIPT.lineageFingerprint,
  capabilityExecutionIds: Object.freeze(["execution-1"]),
});

function workerChild(): CompletedRoleChildResult {
  return Object.freeze({
    callerCallId: "call-root",
    childCallId: "call-worker",
    resultRef: "result-work",
    roleId: "worker",
    objective: "Produce the bounded work result.",
    workingDirectory: ".",
    dependencyResultRefs: Object.freeze(["result-input"]),
    outcome: "completed",
    summary: "The bounded work result was produced.",
    receipt: WORK_RECEIPT,
    workLineage: WORK_LINEAGE,
  }) as unknown as CompletedRoleChildResult;
}

function reviewerChild(): CompletedRoleChildResult {
  const sourceRevision = 11;
  return Object.freeze({
    callerCallId: "call-root",
    childCallId: "call-reviewer",
    resultRef: "result-review",
    roleId: "reviewer",
    objective: "Review the supplied bounded work.",
    dependencyResultRefs: Object.freeze(["result-work"]),
    outcome: "completed",
    summary: "The supplied work passes review.",
    receipt: createRoleCallReviewerVerdictReceipt({
      reviewerCallId: "call-reviewer",
      callerCallId: "call-root",
      reviewScopeId: `review:call-reviewer:r${sourceRevision}`,
      sourceRevision,
      verdict: "pass",
      gaps: [],
    }),
  });
}

function resumeWith(
  completedChildren: readonly CompletedRoleChildResult[],
): RoleChildReturnContext {
  return Object.freeze({
    callerCallId: "call-root",
    invocationAttempt: 3,
    returnedChildCallId: "call-worker",
    returnedResultRef: "result-work",
    completedChildren: Object.freeze([...completedChildren]),
  });
}

function parseResultMessages(
  messages: readonly Readonly<{ role: string; content: string }>[],
): readonly Record<string, unknown>[] {
  return messages
    .filter(({ role }) => role === "user")
    .map(({ content }) => JSON.parse(content) as Record<string, unknown>)
    .filter(({ kind }) => kind === "runtime_child_result");
}

function resultFor(
  messages: readonly Readonly<{ role: string; content: string }>[],
  childCallId: string,
): Record<string, unknown> {
  const result = parseResultMessages(messages).find(
    (message) => message.childCallId === childCallId,
  );
  if (!result) throw new Error("runtime_child_result_missing");
  return result;
}

describe("PR1 work-receipt continuations", () => {
  test("keeps manager full and compact work receipts separate from reviewer verdicts", () => {
    const part = buildSupervisorContinuationPart({
      resume: resumeWith([workerChild(), reviewerChild()]),
      currentCallId: "call-root",
      currentInvocationAttempt: 3,
    });
    if (!part.compactMessages) throw new Error("compact_messages_missing");

    for (const messages of [part.messages, part.compactMessages]) {
      const workResult = resultFor(messages, "call-worker");
      const reviewResult = resultFor(messages, "call-reviewer");
      expect(workResult.workReceipt).toEqual(WORK_RECEIPT);
      expect(workResult.workLineage).toEqual(WORK_LINEAGE);
      expect(workResult.dependencyResultRefs).toEqual(["result-input"]);
      expect(workResult).not.toHaveProperty("reviewerVerdict");
      expect(reviewResult.reviewerVerdict).toMatchObject({
        kind: "reviewer_verdict_v1",
        reviewerCallId: "call-reviewer",
      });
      expect(reviewResult).not.toHaveProperty("workReceipt");
    }
  });

  test("keeps planner full and compact work receipts in the dedicated field", () => {
    const part = buildPlannerChildContinuationPart({
      resume: resumeWith([workerChild()]),
      currentCallId: "call-root",
      currentInvocationAttempt: 3,
    });
    if (!part.compactMessages) throw new Error("compact_messages_missing");

    for (const messages of [part.messages, part.compactMessages]) {
      const workResult = resultFor(messages, "call-worker");
      expect(workResult.workReceipt).toEqual(WORK_RECEIPT);
      expect(workResult.workLineage).toEqual(WORK_LINEAGE);
      expect(workResult.dependencyResultRefs).toEqual(["result-input"]);
      expect(workResult).not.toHaveProperty("reviewerVerdict");
    }
  });
});
