import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

const ASSIGNMENT = "runtime_execution_agent_auditor_assignment_v1";
const INVENTORY = "runtime_execution_agent_auditor_inventory_v1";
const EVIDENCE = "runtime_execution_agent_auditor_evidence_v1";
const STATE = "runtime_execution_state_v1";
type Scenario = "incomplete_request" | "premature_gaps" | "conclusive_gaps";
type Receipt = {
  auditId: string;
  verdict: string;
  requestedEvidenceIds: string[];
  evidenceBinding: {
    workFingerprint: string;
    selectedEvidenceIds: string[];
    bundleFingerprint: string;
  };
};
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
type Proof = {
  selectedEvidenceIds: string[];
  evidence: { executionId: string; adapterResult: unknown }[];
  evidenceProjection: { complete: boolean; omittedEvidenceCount: number };
};

function coverageCase(scenario: Scenario) {
  let rootDecisions = 0;
  let selections = 0;
  let reviews = 0;
  let repairs = 0;
  const reviewAuditIds: string[] = [];
  const receipts: Receipt[] = [];
  const fixture = createAuditorRunnerFixture((input) => {
    const ids = fixture.records.map(({ executionId }) => executionId);
    if (input.modelStep === "execution.decision") {
      rootDecisions += 1;
      if (rootDecisions <= 3) return auditRootPrelude(rootDecisions, 2);
      const state = readAuditCapsule<RootState>(input, STATE);
      const returned = state.completedSubordinateResults.at(-1)!;
      expect(returned.roleId).toBe("reviewer");
      expect(returned.outcome).toBe("completed");
      const receipt = JSON.parse(returned.summary) as Receipt;
      receipts.push(receipt);
      if (rootDecisions === 4 && scenario !== "conclusive_gaps") {
        expect(receipt.verdict).toBe("needs_evidence");
        expect(receipt.requestedEvidenceIds).toEqual(ids);
        expect(receipt.evidenceBinding.selectedEvidenceIds).toEqual([ids[0]]);
        expect(state.completedSubordinateResults).toHaveLength(1);
        expect(state.auditAvailability).toMatchObject({
          available: true,
          reason: "auditor_requested_evidence",
          pendingEvidenceIds: ids,
        });
        expect(repairs).toBe(1);
        expect(fixture.execute).toHaveBeenCalledTimes(2);
        return { action: "invoke_auditor", criterionIds: AUDIT_CRITERION_IDS };
      }
      expect(receipt.verdict).toBe(
        scenario === "conclusive_gaps" ? "gaps" : "pass",
      );
      expect(receipt.evidenceBinding.selectedEvidenceIds).toEqual(ids);
      expect(state.completedSubordinateResults).toHaveLength(
        scenario === "conclusive_gaps" ? 1 : 2,
      );
      expect(state.auditAvailability).toMatchObject({
        available: false,
        reason: "audit_finished_for_work",
        pendingEvidenceIds: null,
      });
      expect(JSON.stringify(input.format)).not.toContain('"invoke_auditor"');
      return { action: "respond" };
    }
    expect(input.modelStep).toBe("auditor.decision");
    const { auditId } = readAuditCapsule<{ auditId: string }>(
      input,
      ASSIGNMENT,
    );
    const inventory = readAuditCapsule<{
      inventory: { executionId: string }[];
    }>(input, INVENTORY);
    expect(inventory.inventory.map(({ executionId }) => executionId)).toEqual(
      ids,
    );
    if (auditFormatName(input) === "auditor_evidence_selection") {
      selections += 1;
      return {
        auditId,
        selectedEvidenceIds: scenario === "conclusive_gaps" ? ids : [ids[0]],
      };
    }
    expect(auditFormatName(input)).toBe("auditor_decision");
    reviews += 1;
    reviewAuditIds.push(auditId);
    const proof = readAuditCapsule<Proof>(input, EVIDENCE);
    const selected =
      scenario === "conclusive_gaps" || reviews === 3
        ? fixture.records
        : fixture.records.slice(0, 1);
    expect(proof.selectedEvidenceIds).toEqual(
      selected.map(({ executionId }) => executionId),
    );
    expect(proof.evidence.map(({ adapterResult }) => adapterResult)).toEqual(
      selected.map(({ exactResult }) => exactResult),
    );
    expect(proof.evidenceProjection).toMatchObject({
      complete: true,
      omittedEvidenceCount: 0,
    });
    let verdict: "pass" | "gaps" | "needs_evidence";
    let requestedEvidenceIds: string[] = [];
    if (scenario === "conclusive_gaps") {
      verdict = "gaps";
    } else if (reviews === 1) {
      verdict = scenario === "incomplete_request" ? "needs_evidence" : "gaps";
      requestedEvidenceIds = scenario === "incomplete_request" ? [ids[1]!] : [];
    } else if (reviews === 2) {
      // Existing structured-output repair stays within the original audit call.
      expect(auditId).toBe(reviewAuditIds[0]);
      expect(rootDecisions).toBe(3);
      expect(fixture.execute).toHaveBeenCalledTimes(2);
      const repair = auditMessages(input).filter(({ content }) =>
        content.includes("Repair attempt: 1."),
      );
      expect(repair).toHaveLength(1);
      expect(repair[0]!.role).toBe("system");
      expect(repair[0]!.content).toContain("decision.evidenceCoverage");
      repairs += 1;
      verdict = "needs_evidence";
      requestedEvidenceIds = ids;
    } else {
      expect(reviews).toBe(3);
      expect(auditId).not.toBe(reviewAuditIds[0]);
      expect(rootDecisions).toBe(4);
      verdict = "pass";
    }
    return {
      auditId,
      verdict,
      criterionIds: AUDIT_CRITERION_IDS,
      gaps:
        verdict === "pass"
          ? []
          : [
              {
                criterionId: AUDIT_CRITERION_IDS[0],
                description:
                  "Both original observations are required to assess this criterion.",
              },
            ],
      neededEvidenceIds: ids,
      notNeededEvidenceIds: [],
      requestedEvidenceIds,
    };
  }, 2);
  return {
    ...fixture,
    receipts,
    reviewAuditIds,
    counts: () => ({ rootDecisions, selections, reviews, repairs }),
  };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Auditor evidence coverage through root and existing structured repair", () => {
  test.each(["incomplete_request", "premature_gaps"] as const)(
    "repairs %s before settling and resumes with every needed original",
    async (scenario) => {
      const fixture = coverageCase(scenario);
      await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
        output: AUDIT_RUNNER_FINAL,
      });
      expect(fixture.counts()).toEqual({
        rootDecisions: 5,
        selections: 1,
        reviews: 3,
        repairs: 1,
      });
      expect(fixture.receipts.map(({ verdict }) => verdict)).toEqual([
        "needs_evidence",
        "pass",
      ]);
      expect(fixture.receipts[1]!.evidenceBinding.workFingerprint).toBe(
        fixture.receipts[0]!.evidenceBinding.workFingerprint,
      );
      expect(fixture.receipts[1]!.evidenceBinding.bundleFingerprint).not.toBe(
        fixture.receipts[0]!.evidenceBinding.bundleFingerprint,
      );
      expect(
        fixture.invoke.mock.calls.map(([input]) => input.modelStep),
      ).toEqual([
        "execution.decision",
        "execution.decision",
        "execution.decision",
        "auditor.decision",
        "auditor.decision",
        "auditor.decision",
        "execution.decision",
        "auditor.decision",
        "execution.decision",
        "execution.response",
      ]);
      expect(fixture.execute).toHaveBeenCalledTimes(2);
      expect(fixture.invokeRaw).not.toHaveBeenCalled();
      expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        AUDIT_RUNNER_FINAL,
      );
    },
  );

  test("accepts conclusive gaps once every declared needed original is present", async () => {
    const fixture = coverageCase("conclusive_gaps");
    await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
      output: AUDIT_RUNNER_FINAL,
    });
    expect(fixture.counts()).toEqual({
      rootDecisions: 4,
      selections: 1,
      reviews: 1,
      repairs: 0,
    });
    expect(fixture.receipts.map(({ verdict }) => verdict)).toEqual(["gaps"]);
    expect(
      fixture.invoke.mock.calls.filter(
        ([input]) => input.modelStep === "auditor.decision",
      ),
    ).toHaveLength(2);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      AUDIT_RUNNER_FINAL,
    );
  });
});
