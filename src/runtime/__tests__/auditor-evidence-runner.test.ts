import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import {
  AUDIT_CRITERION_IDS,
  AUDIT_RUNNER_FINAL,
  AUDIT_RUNNER_PROMPT,
  auditFormatName,
  auditMessages,
  auditRootPrelude,
  createAuditorRunnerFixture,
  readAuditCapsule,
  type AuditRunnerInput,
} from "./support/auditor-runner-fixture.js";

const ASSIGNMENT_KIND = "runtime_execution_agent_auditor_assignment_v1";
const INVENTORY_KIND = "runtime_execution_agent_auditor_inventory_v1";
const EVIDENCE_KIND = "runtime_execution_agent_auditor_evidence_v1";
const STATE_KIND = "runtime_execution_state_v1";

type AuditAssignment = {
  auditId: string;
  target: string;
  phase: "selection" | "review";
};
type AuditInventory = { inventory: readonly { executionId: string }[] };
type AuditProof = {
  evidence: readonly { executionId: string; adapterResult: unknown }[];
  evidenceProjection: { complete: boolean; omittedEvidenceCount: number };
};
type RootAuditState = {
  auditAvailability: {
    available: boolean;
    reason: string;
    workFingerprint: string;
    pendingEvidenceIds: readonly string[] | null;
    reviewedBundleCount: number;
  };
  completedSubordinateResults: readonly {
    roleId: string;
    outcome: string;
    summary: string;
  }[];
};
type AuditReceipt = {
  kind: string;
  authority: string;
  auditId: string;
  verdict: string;
  requestedEvidenceIds?: readonly string[];
  evidenceBinding: {
    kind: string;
    workFingerprint: string;
    selectedEvidenceIds: readonly string[];
    bundleFingerprint: string | null;
  };
};

function returnedAuditReceipts(input: AuditRunnerInput): AuditReceipt[] {
  const state = readAuditCapsule<RootAuditState>(input, STATE_KIND);
  return state.completedSubordinateResults.map(({ roleId, summary }) => {
    expect(roleId).toBe("reviewer");
    const receipt = JSON.parse(summary) as AuditReceipt;
    expect(receipt.kind).toBe("runtime_execution_agent_auditor_advisory_v1");
    return receipt;
  });
}

function expectRootRequestOnce(input: AuditRunnerInput): void {
  expect(
    auditMessages(input).filter(
      ({ role, content }) => role === "user" && content === AUDIT_RUNNER_PROMPT,
    ),
  ).toHaveLength(1);
}

function expectAuditClosed(
  input: AuditRunnerInput,
  receiptCount: number,
): void {
  const state = readAuditCapsule<RootAuditState>(input, STATE_KIND);
  expect(state.auditAvailability).toMatchObject({
    available: false,
    reason: "audit_finished_for_work",
    pendingEvidenceIds: null,
  });
  expect(state.completedSubordinateResults).toHaveLength(receiptCount);
  expect(JSON.stringify(input.format)).not.toContain('"invoke_auditor"');
  expect(JSON.stringify(input.format)).toContain('"respond"');
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Auditor evidence selection through the shared request runner", () => {
  test("returns an evidence request to root and binds the complete new bundle on its next audit", async () => {
    let rootDecisions = 0;
    let reviews = 0;
    let selections = 0;
    let workFingerprint = "";
    const auditIds: string[] = [];
    const fixture = createAuditorRunnerFixture((input) => {
      if (input.modelStep === "execution.decision") {
        rootDecisions += 1;
        expectRootRequestOnce(input);
        if (rootDecisions <= 2) return auditRootPrelude(rootDecisions, 18);
        const state = readAuditCapsule<RootAuditState>(input, STATE_KIND);
        if (rootDecisions === 3) {
          expect(state.auditAvailability).toMatchObject({
            available: true,
            reason: "new_work",
            reviewedBundleCount: 0,
          });
          workFingerprint = state.auditAvailability.workFingerprint;
          expect(workFingerprint).not.toBe("");
          return auditRootPrelude(rootDecisions, 18);
        }
        const receipts = returnedAuditReceipts(input);
        expect(
          receipts.map(
            ({ evidenceBinding }) => evidenceBinding.workFingerprint,
          ),
        ).toEqual(Array(receipts.length).fill(workFingerprint));
        if (rootDecisions === 4) {
          expect(state.auditAvailability).toMatchObject({
            available: true,
            reason: "auditor_requested_evidence",
            pendingEvidenceIds: fixture.records
              .slice(0, 2)
              .map(({ executionId }) => executionId),
            reviewedBundleCount: 1,
          });
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({
            authority: "model_advisory",
            auditId: auditIds[0],
            verdict: "needs_evidence",
            requestedEvidenceIds: fixture.records
              .slice(0, 2)
              .map(({ executionId }) => executionId),
            evidenceBinding: {
              kind: "runtime_auditor_evidence_binding_v1",
              selectedEvidenceIds: [fixture.records[0]!.executionId],
              bundleFingerprint: expect.any(String),
            },
          });
          return {
            action: "invoke_auditor",
            criterionIds: AUDIT_CRITERION_IDS,
          };
        }
        expect(rootDecisions).toBe(5);
        expectAuditClosed(input, 2);
        expect(state.auditAvailability.reviewedBundleCount).toBe(2);
        expect(
          receipts.map(({ auditId, verdict }) => ({ auditId, verdict })),
        ).toEqual([
          { auditId: auditIds[0], verdict: "needs_evidence" },
          { auditId: auditIds[1], verdict: "pass" },
        ]);
        expect(receipts[1]!.evidenceBinding.selectedEvidenceIds).toEqual(
          fixture.records.slice(0, 2).map(({ executionId }) => executionId),
        );
        return { action: "respond" };
      }
      expect(input.modelStep).toBe("auditor.decision");
      const assignment = readAuditCapsule<AuditAssignment>(
        input,
        ASSIGNMENT_KIND,
      );
      const inventory = readAuditCapsule<AuditInventory>(input, INVENTORY_KIND);
      const inventoryIds = inventory.inventory.map(
        ({ executionId }) => executionId,
      );
      expect(inventoryIds).toEqual(
        fixture.records.map(({ executionId }) => executionId),
      );
      expect(inventory.inventory).toHaveLength(18);
      expect(JSON.stringify(inventory)).not.toContain(
        "runtime_execution_agent_auditor_advisory_v1",
      );
      expect(JSON.stringify(inventory)).not.toContain(
        fixture.records[0]!.exactResult.payload.referenceData,
      );
      expect(JSON.parse(assignment.target)).toMatchObject({
        currentRequest: AUDIT_RUNNER_PROMPT,
      });
      if (auditFormatName(input) === "auditor_evidence_selection") {
        selections += 1;
        expect(selections).toBe(1);
        expect(assignment.phase).toBe("selection");
        expect(
          auditMessages(input).some(({ content }) =>
            content.includes(EVIDENCE_KIND),
          ),
        ).toBe(false);
        return {
          auditId: assignment.auditId,
          selectedEvidenceIds: [inventoryIds[0]],
        };
      }
      expect(auditFormatName(input)).toBe("auditor_decision");
      expect(assignment.phase).toBe("review");
      reviews += 1;
      auditIds.push(assignment.auditId);
      const proof = readAuditCapsule<AuditProof>(input, EVIDENCE_KIND);
      const expectedRecords = fixture.records.slice(0, reviews);
      expect(proof.evidence.map(({ executionId }) => executionId)).toEqual(
        expectedRecords.map(({ executionId }) => executionId),
      );
      expect(proof.evidence.map(({ adapterResult }) => adapterResult)).toEqual(
        expectedRecords.map(({ exactResult }) => exactResult),
      );
      expect(proof.evidenceProjection).toMatchObject({
        complete: true,
        omittedEvidenceCount: 0,
      });
      const needsEvidence = reviews === 1;
      return {
        auditId: assignment.auditId,
        verdict: needsEvidence ? "needs_evidence" : "pass",
        criterionIds: AUDIT_CRITERION_IDS,
        gaps: needsEvidence
          ? [
              {
                criterionId: AUDIT_CRITERION_IDS[0],
                description: "The second exact observation is required.",
              },
            ]
          : [],
        neededEvidenceIds: inventoryIds.slice(0, 2),
        notNeededEvidenceIds: inventoryIds.slice(2),
        requestedEvidenceIds: needsEvidence ? inventoryIds.slice(0, 2) : [],
      };
    });
    expect(
      JSON.stringify(fixture.records.map(({ exactResult }) => exactResult))
        .length,
    ).toBeGreaterThan(48_000);
    await expect(runRequestRunner(fixture.request)).resolves.toEqual({
      output: AUDIT_RUNNER_FINAL,
      outputTextMode: "exact",
    });
    expect(new Set(auditIds).size).toBe(2);
    expect(selections).toBe(1);
    expect(reviews).toBe(2);
    expect(fixture.execute).toHaveBeenCalledTimes(18);
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(
      [
        "execution.decision",
        "execution.decision",
        "execution.decision",
        "auditor.decision",
        "auditor.decision",
        "execution.decision",
        "auditor.decision",
        "execution.decision",
        "execution.response",
      ],
    );
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
      AUDIT_RUNNER_FINAL,
    );
  });

  test.each(["gaps", "failed"] as const)(
    "returns %s as a passive child result and closes unchanged work",
    async (outcome) => {
      let rootDecisions = 0;
      const fixture = createAuditorRunnerFixture((input) => {
        if (input.modelStep === "execution.decision") {
          rootDecisions += 1;
          expectRootRequestOnce(input);
          if (rootDecisions <= 3) return auditRootPrelude(rootDecisions, 1);
          expect(rootDecisions).toBe(4);
          expectAuditClosed(input, 1);
          const receipts = returnedAuditReceipts(input);
          expect(receipts[0]).toMatchObject({ verdict: outcome });
          const state = readAuditCapsule<RootAuditState>(input, STATE_KIND);
          expect(state.completedSubordinateResults[0]!.outcome).toBe(
            outcome === "failed" ? "failed" : "completed",
          );
          return { action: "respond" };
        }
        expect(input.modelStep).toBe("auditor.decision");
        const assignment = readAuditCapsule<AuditAssignment>(
          input,
          ASSIGNMENT_KIND,
        );
        const { inventory } = readAuditCapsule<AuditInventory>(
          input,
          INVENTORY_KIND,
        );
        const executionId = inventory[0]!.executionId;
        if (auditFormatName(input) === "auditor_evidence_selection") {
          return {
            auditId: assignment.auditId,
            selectedEvidenceIds: [
              outcome === "failed" ? "foreign-execution" : executionId,
            ],
          };
        }
        expect(outcome).toBe("gaps");
        expect(auditFormatName(input)).toBe("auditor_decision");
        return {
          auditId: assignment.auditId,
          verdict: "gaps",
          criterionIds: AUDIT_CRITERION_IDS,
          gaps: [
            {
              criterionId: AUDIT_CRITERION_IDS[0],
              description: "The observation leaves a gap.",
            },
          ],
          neededEvidenceIds: [executionId],
          notNeededEvidenceIds: [],
          requestedEvidenceIds: [],
        };
      }, 1);
      await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
        output: AUDIT_RUNNER_FINAL,
      });
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(fixture.invokeRaw).not.toHaveBeenCalled();
      expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        AUDIT_RUNNER_FINAL,
      );
    },
  );
});
