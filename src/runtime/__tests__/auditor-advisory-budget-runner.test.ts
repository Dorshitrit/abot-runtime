import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedgerCommand,
} from "../orchestration/role-calls/index.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { EXECUTION_AGENT_AUDITOR_EXECUTOR } from "../steps/auditor-decision/run.js";
import { encodeExecutionAgentAuditObjective } from "../steps/auditor-decision/contracts.js";
import { projectAuditorInputState } from "../steps/auditor-decision/audit-input-state.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import {
  AUDIT_CRITERION_IDS,
  AUDIT_RUNNER_FINAL,
  auditFormatName,
  auditMessages,
  auditRootPrelude,
  createAuditorRunnerFixture,
  readAuditCapsule,
} from "./support/auditor-runner-fixture.js";

type RootState = {
  auditAvailability: {
    available: boolean;
    reason: string;
    pendingEvidenceIds: string[] | null;
  };
  completedSubordinateResults: {
    roleId: string;
    outcome: string;
    summary: string;
  }[];
};
type Receipt = {
  verdict: string;
  requestedEvidenceIds: string[];
  gaps: { description: string }[];
  evidenceBinding: {
    workFingerprint: string;
    selectedEvidenceIds: string[];
    bundleFingerprint: string;
  };
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test("returns the largest offered escaped evidence request intact and resumes review through the root", async () => {
  let roots = 0;
  let selections = 0;
  let reviews = 0;
  let description = "";
  const receipts: Receipt[] = [];
  const fixture = createAuditorRunnerFixture((input) => {
    const ids = fixture.records.map(({ executionId }) => executionId);
    if (input.modelStep === "execution.decision") {
      roots += 1;
      if (roots <= 3) return auditRootPrelude(roots, 2);
      const state = readAuditCapsule<RootState>(
        input,
        "runtime_execution_state_v1",
      );
      const returned = state.completedSubordinateResults.at(-1)!;
      expect(returned.roleId).toBe("reviewer");
      expect(returned.outcome).toBe("completed");
      expect(returned.summary.length).toBeLessThanOrEqual(
        ROLE_CALL_RESULT_MAX_LENGTH,
      );
      const receipt = JSON.parse(returned.summary) as Receipt;
      receipts.push(receipt);
      expect(fixture.execute).toHaveBeenCalledTimes(2);
      if (roots === 4) {
        expect(receipt.verdict).toBe("needs_evidence");
        expect(receipt.gaps[0]!.description).toBe(description);
        expect(receipt.requestedEvidenceIds).toEqual(ids);
        expect(receipt.evidenceBinding.selectedEvidenceIds).toEqual(
          ids.slice(0, 1),
        );
        expect(state.auditAvailability).toMatchObject({
          available: true,
          reason: "auditor_requested_evidence",
          pendingEvidenceIds: ids,
        });
        return { action: "invoke_auditor", criterionIds: AUDIT_CRITERION_IDS };
      }
      expect(roots).toBe(5);
      expect(receipt.verdict).toBe("pass");
      expect(receipt.evidenceBinding.selectedEvidenceIds).toEqual(ids);
      expect(state.auditAvailability).toMatchObject({
        available: false,
        reason: "audit_finished_for_work",
        pendingEvidenceIds: null,
      });
      return { action: "respond" };
    }
    expect(input.modelStep).toBe("auditor.decision");
    const assigned = readAuditCapsule<{
      auditId: string;
      resultConstraints?: Record<string, unknown>;
    }>(input, "runtime_execution_agent_auditor_assignment_v1");
    const { auditId } = assigned;
    const messages = auditMessages(input);
    expect(messages.map(({ role }) => role)).toEqual(
      auditFormatName(input) === "auditor_evidence_selection"
        ? ["system", "user", "user"]
        : ["system", "user", "user", "user"],
    );
    if (auditFormatName(input) === "auditor_evidence_selection") {
      expect(assigned).not.toHaveProperty("resultConstraints");
      selections += 1;
      return { auditId, selectedEvidenceIds: ids.slice(0, 1) };
    }
    reviews += 1;
    expect(reviews).toBeLessThanOrEqual(2);
    const proof = readAuditCapsule<{
      selectedEvidenceIds: string[];
      evidence: { adapterResult: unknown }[];
    }>(input, "runtime_execution_agent_auditor_evidence_v1");
    const records =
      reviews === 1 ? fixture.records.slice(0, 1) : fixture.records;
    expect(proof.selectedEvidenceIds).toEqual(
      records.map(({ executionId }) => executionId),
    );
    expect(proof.evidence.map(({ adapterResult }) => adapterResult)).toEqual(
      records.map(({ exactResult }) => exactResult),
    );
    const limit = Number(
      JSON.stringify(input.format).match(/"maxLength":(\d+)/u)![1],
    );
    expect(assigned.resultConstraints).toEqual({
      authority: "runtime_result_capacity",
      perDescriptionMaxLength: limit,
      receiptMaxChars: ROLE_CALL_RESULT_MAX_LENGTH,
      descriptionLengthUnit: "Unicode code points",
      receiptLengthUnit: "UTF-16 code units",
    });
    description = "\u0001".repeat(limit);
    return {
      auditId,
      verdict: reviews === 1 ? "needs_evidence" : "pass",
      criterionIds: AUDIT_CRITERION_IDS,
      gaps:
        reviews === 1
          ? [{ criterionId: AUDIT_CRITERION_IDS[0], description }]
          : [],
      neededEvidenceIds: ids,
      notNeededEvidenceIds: [],
      requestedEvidenceIds: reviews === 1 ? ids : [],
    };
  }, 2);
  await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
    output: AUDIT_RUNNER_FINAL,
  });
  expect({ roots, selections, reviews }).toEqual({
    roots: 5,
    selections: 1,
    reviews: 2,
  });
  expect(receipts.map(({ verdict }) => verdict)).toEqual([
    "needs_evidence",
    "pass",
  ]);
  expect(receipts[1]!.evidenceBinding.workFingerprint).toBe(
    receipts[0]!.evidenceBinding.workFingerprint,
  );
  expect(receipts[1]!.evidenceBinding.bundleFingerprint).not.toBe(
    receipts[0]!.evidenceBinding.bundleFingerprint,
  );
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision",
    "execution.decision",
    "execution.decision",
    "auditor.decision",
    "auditor.decision",
    "execution.decision",
    "auditor.decision",
    "execution.decision",
    "execution.response",
  ]);
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
  expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
    AUDIT_RUNNER_FINAL,
  );
});

test("metadata capacity failure precedes review and returns a bounded canonical failed receipt", async () => {
  let selections = 0;
  const fixture = createAuditorRunnerFixture((input) => {
    expect(input.modelStep).toBe("auditor.decision");
    expect(auditFormatName(input)).toBe("auditor_evidence_selection");
    selections += 1;
    const { auditId } = readAuditCapsule<{ auditId: string }>(
      input,
      "runtime_execution_agent_auditor_assignment_v1",
    );
    return {
      auditId,
      selectedEvidenceIds: fixture.records.map(
        ({ executionId }) => executionId,
      ),
    };
  }, 192);
  const ledger = createRoleCallLedger({
    requestId: fixture.request.requestId,
    policy: {
      authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      limits: {
        maxDepth: 4,
        maxCalls: 48,
        maxCapabilityExecutions: 192,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  const commit = async (command: RoleCallLedgerCommand) => {
    const result = await ledger.apply({
      expectedHead: ledger.current(),
      command,
    });
    if (!result.ok) throw new Error(result.code);
    return result;
  };
  await commit({ authority: "runtime", type: "create_root" });
  for (const record of fixture.records) {
    const started = await commit({
      authority: "active_role",
      type: "begin_capability_execution",
      callId: "call-1",
      invocationAttempt: ledger.current().state.calls[0]!.activationCount,
      capabilityId: "fixture.observe",
      declaredEffect: "observation",
      intent: "Observe.",
      controlsJson: "{}",
    });
    if (started.effect.type !== "capability_execution_begun")
      throw new Error("unexpected_effect");
    await commit({
      authority: "runtime",
      type: "settle_capability_execution",
      callId: "call-1",
      executionId: started.effect.executionId,
      outcome: "succeeded",
      observedEffect: "observation",
      summary: "Observed.",
      exactResult: record.exactResult,
    });
  }
  await commit({
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "reviewer",
    objective: encodeExecutionAgentAuditObjective(AUDIT_CRITERION_IDS),
  });
  const call = ledger.current().state.calls.at(-1)!;
  const result = await EXECUTION_AGENT_AUDITOR_EXECUTOR.execute({
    context: fixture.request,
    call,
    ledger,
    availableChildRoleIds: [],
  });
  expect(result).toMatchObject({ kind: "terminal", outcome: "failed" });
  if (result.kind !== "terminal") throw new Error("expected_terminal");
  expect(result.summary.length).toBeLessThanOrEqual(
    ROLE_CALL_RESULT_MAX_LENGTH,
  );
  expect(JSON.parse(result.summary)).toMatchObject({
    authority: "runtime_validation",
    verdict: "failed",
    reason: "auditor_result_metadata_exceeds_budget",
    evidenceBinding: {
      selectedEvidenceIds: fixture.records.map(
        ({ executionId }) => executionId,
      ),
    },
  });
  expect(selections).toBe(1);
  expect(fixture.invoke).toHaveBeenCalledOnce();
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
  expect(fixture.execute).not.toHaveBeenCalled();
  await commit({
    authority: "runtime",
    type: "return_child",
    callerCallId: "call-1",
    childCallId: call.callId,
    outcome: result.outcome,
    summary: result.summary,
  });
  expect(projectAuditorInputState(ledger.current(), "call-1", 0)).toMatchObject(
    {
      available: false,
      reason: "audit_finished_for_work",
      pendingEvidenceIds: null,
    },
  );
});
