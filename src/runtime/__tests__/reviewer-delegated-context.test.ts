import { describe, expect, test } from "vitest";

import {
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  createRoleCallLedger,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
} from "../orchestration/role-calls/index.js";
import { projectReviewerModelContext } from "../steps/reviewer-decision/model-context.js";
import { projectReviewerReviewSnapshot } from "../steps/reviewer-decision/projection.js";

const REQUEST_ID = "request-reviewer-delegated-context";
const REQUEST_OBJECTIVE = "Deliver the exact requested artifact.";
const SELECTED_OBJECTIVE = "Create the exact requested artifact.";
const SELECTED_SUMMARY = "The requested artifact was created.";
const UNRELATED_OBJECTIVE = "Prepare an unrelated optional appendix.";
const UNRELATED_SUMMARY = "The optional appendix was prepared.";

describe("Reviewer delegated context", () => {
  test("projects the active audit assignment and only exact dependency results", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const root = requireActiveCall(ledger);

    const selectedResultRef = await completeChild(
      ledger,
      root.callId,
      SELECTED_OBJECTIVE,
      SELECTED_SUMMARY,
    );
    await completeChild(
      ledger,
      root.callId,
      UNRELATED_OBJECTIVE,
      UNRELATED_SUMMARY,
    );
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: root.callId,
      roleId: "reviewer",
      objective: REQUEST_OBJECTIVE,
      dependencyResultRefs: [selectedResultRef],
    });
    const reviewer = requireActiveCall(ledger);

    const snapshot = projectReviewerReviewSnapshot({
      requestId: REQUEST_ID,
      requestObjective: REQUEST_OBJECTIVE,
      ledger,
      call: reviewer,
      referenceDataBudget: {
        maxTokens: 1_000,
        tokenEstimation: { asciiCharactersPerToken: 4 },
      },
      trace: false,
    });
    const capsule = JSON.parse(
      projectReviewerModelContext(snapshot, reviewer).prompt,
    ) as Record<string, unknown>;

    expect(snapshot.subjects).toEqual([
      {
        subjectRef: `call:${root.callId}`,
        kind: "caller_objective",
        summary: REQUEST_OBJECTIVE,
      },
      {
        subjectRef: "call:call-2",
        kind: "worker_result",
        summary: SELECTED_OBJECTIVE,
      },
    ]);
    expect(snapshot.facts).toEqual([
      expect.objectContaining({
        factRef: selectedResultRef,
        subjectRefs: ["call:call-2"],
        summary: SELECTED_SUMMARY,
      }),
    ]);
    expect(capsule).toMatchObject({
      kind: "runtime_reviewer_audit_v4",
      assignment: {
        authority: "canonical_reviewer_call",
        callId: reviewer.callId,
        purpose: "audit_supplied_completion_target",
        presenceEffect: "active_reviewer_assignment_only",
        completionTargetRef: `call:${root.callId}`,
      },
      dependencySubjects: [
        {
          authority: "canonical_role_call_dependency_result",
          presenceEffect:
            "passive_support_not_user_intent_pending_work_completion_or_verdict",
          subjectRef: "call:call-2",
          resultRef: selectedResultRef,
          producerCallId: "call-2",
          roleId: "worker",
          objective: SELECTED_OBJECTIVE,
          summary: SELECTED_SUMMARY,
          outcome: "completed",
        },
      ],
      supportSubjects: [],
      candidateSupportEdges: [
        {
          sourceSubjectRef: "call:call-2",
          targetSubjectRef: `call:${root.callId}`,
          relation: "candidate_support",
        },
      ],
      claims: [],
      effects: [],
      completionTarget: {
        subjectRef: `call:${root.callId}`,
        text: REQUEST_OBJECTIVE,
      },
    });
    expect(JSON.stringify({ snapshot, capsule })).not.toContain(
      UNRELATED_OBJECTIVE,
    );
    expect(JSON.stringify({ snapshot, capsule })).not.toContain(
      UNRELATED_SUMMARY,
    );
    expect(JSON.stringify({ snapshot, capsule })).not.toContain("call:call-3");
    expect(JSON.stringify({ snapshot, capsule })).not.toContain("result-2");
  });

  test("rejects a Reviewer objective that diverges from the completion target", async () => {
    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    const root = requireActiveCall(ledger);
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: root.callId,
      roleId: "reviewer",
      objective: "Invent another audit requirement.",
    });

    expect(() =>
      projectReviewerReviewSnapshot({
        requestId: REQUEST_ID,
        requestObjective: REQUEST_OBJECTIVE,
        ledger,
        call: requireActiveCall(ledger),
        referenceDataBudget: {
          maxTokens: 1_000,
          tokenEstimation: { asciiCharactersPerToken: 4 },
        },
        trace: false,
      }),
    ).toThrow("reviewer_snapshot_completion_target_binding_invalid");
  });
});

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: REQUEST_ID,
    policy: {
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

async function completeChild(
  ledger: RoleCallLedger,
  callerCallId: string,
  objective: string,
  summary: string,
): Promise<string> {
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId,
    roleId: "worker",
    objective,
  });
  const child = requireActiveCall(ledger);
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId,
    childCallId: child.callId,
    outcome: "completed",
    summary,
  });
  const resultRef = ledger.current().state.calls.find(
    ({ callId }) => callId === child.callId,
  )?.resultRef;
  if (!resultRef) throw new Error("completed child result missing");
  return resultRef;
}

async function commit(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
): Promise<void> {
  const result = await ledger.apply({ expectedHead: ledger.current(), command });
  if (!result.ok) throw new Error(`fixture commit failed:${result.code}`);
}

function requireActiveCall(ledger: RoleCallLedger): RoleCallFrame {
  const head = ledger.current();
  const call = head.state.calls.find(
    ({ callId }) => callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active call missing");
  return call;
}
