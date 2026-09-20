import { describe, expect, test } from "vitest";
import type {
  AuditorAssignment,
  AuditorCapabilityEvidence,
  AuditorDecision,
} from "../steps/auditor-decision/contracts.js";
import { bindAuditorEvidence } from "../steps/auditor-decision/evidence-binding.js";
import { fingerprintAuditorEvidence } from "../steps/auditor-decision/evidence-inventory.js";
import { parseAuditorDecisionOutput } from "../steps/auditor-decision/parser.js";

const ids = ["execution-1", "execution-2", "execution-3"];
const criteria = ["request_completion"];
const source: AuditorCapabilityEvidence[] = ids.map((executionId) => ({
  kind: "capability_result",
  executionId,
  capabilityId: "fixture.observe",
  declaredEffect: "observation",
  outcome: "succeeded",
  observedEffect: "observation",
  summary: `Observed ${executionId}.`,
  adapterResult: {
    kind: "generic_capability_result_v1",
    authority: "capability_adapter",
    status: "executed",
    ok: true,
    payload: { original: executionId },
  },
}));

function assignment(selectedIds = ids.slice(0, 1)): AuditorAssignment {
  const unbound: AuditorAssignment = {
    auditId: "audit-1",
    callerCallId: "root-1",
    target: "Inspect the records.",
    sourceRevision: 10,
    criterionIds: criteria,
    criteria: [
      { criterionId: criteria[0]!, description: "All work is complete." },
    ],
    workFingerprint: "work-fingerprint",
    inventory: source.map((entry, index) => ({
      executionId: entry.executionId,
      callId: "root-1",
      invocationAttempt: index + 1,
      capabilityId: entry.capabilityId,
      declaredEffect: entry.declaredEffect,
      outcome: entry.outcome,
      observedEffect: entry.observedEffect,
      summaryPreview: {
        text: entry.summary,
        originalChars: entry.summary.length,
        truncated: false,
      },
      targetPreviews: [],
      referenceCount: 0,
      omittedReferencePreviewCount: 0,
      exactEvidenceChars: JSON.stringify(entry).length,
      evidenceFingerprint: fingerprintAuditorEvidence(entry),
    })),
    selectedEvidenceIds: [],
    reviewedBundleFingerprints: [],
    reviewedEvidenceBundles: [],
    pendingEvidenceIds: null,
    evidence: [],
    availableEvidenceCount: source.length,
    omittedEvidenceCount: 0,
  };
  return bindAuditorEvidence(unbound, source, selectedIds);
}

function parse(
  bound: AuditorAssignment,
  overrides: Partial<AuditorDecision> = {},
) {
  const decision: AuditorDecision = {
    auditId: bound.auditId,
    verdict: "gaps",
    criterionIds: criteria,
    gaps: [
      {
        criterionId: criteria[0]!,
        description: "The required outcome is not established.",
      },
    ],
    neededEvidenceIds: ids.slice(0, 2),
    notNeededEvidenceIds: ids.slice(2),
    requestedEvidenceIds: [],
    ...overrides,
  };
  return parseAuditorDecisionOutput(JSON.stringify({ decision }), bound);
}

function expectIssue(result: ReturnType<typeof parse>, code: string): void {
  expect(result).toMatchObject({
    ok: false,
    stage: "domain_parser",
    issues: expect.arrayContaining([
      { code, path: "decision.evidenceCoverage", message: expect.any(String) },
    ]),
  });
}

describe("whole original proof for Auditor evidence coverage", () => {
  test("rejects a delta-only evidence request that drops an already needed original", () => {
    expectIssue(
      parse(assignment(), {
        verdict: "needs_evidence",
        requestedEvidenceIds: ids.slice(1, 2),
      }),
      "auditor_requested_needed_evidence_missing",
    );
  });

  test.each([
    { requestedEvidenceIds: ids.slice(0, 2) },
    { requestedEvidenceIds: ids },
  ])(
    "accepts a fresh next bundle containing every needed original: $requestedEvidenceIds",
    ({ requestedEvidenceIds }) => {
      expect(
        parse(assignment(), {
          verdict: "needs_evidence",
          requestedEvidenceIds,
        }),
      ).toMatchObject({ ok: true });
    },
  );

  test("rejects conclusive gaps based on an unselected needed original", () => {
    expectIssue(parse(assignment()), "auditor_gaps_needed_evidence_missing");
  });

  test("rejects conclusive gaps when selected original proof was omitted", () => {
    const bound = assignment(ids.slice(0, 2));
    expectIssue(
      parse({
        ...bound,
        evidence: bound.evidence.slice(0, 1),
        omittedEvidenceCount: 1,
      }),
      "auditor_gaps_evidence_incomplete",
    );
  });

  test("accepts gaps supported by all needed originals in the current bundle", () => {
    expect(parse(assignment(ids.slice(0, 2)))).toMatchObject({
      ok: true,
      decision: { verdict: "gaps", neededEvidenceIds: ids.slice(0, 2) },
    });
  });

  test("preserves gaps with an empty needed set while pass still requires proof", () => {
    const emptyNeeded = { neededEvidenceIds: [], notNeededEvidenceIds: ids };
    expect(parse(assignment(), emptyNeeded)).toMatchObject({ ok: true });
    expectIssue(
      parse(assignment(), { ...emptyNeeded, verdict: "pass", gaps: [] }),
      "auditor_pass_needed_evidence_missing",
    );
  });

  test("preserves inventory partition and already reviewed bundle rejection", () => {
    expectIssue(
      parse(assignment(), { notNeededEvidenceIds: [] }),
      "auditor_evidence_coverage_invalid",
    );
    expectIssue(
      parse(assignment(), {
        verdict: "needs_evidence",
        requestedEvidenceIds: ids.slice(0, 1),
      }),
      "auditor_evidence_bundle_already_reviewed",
    );
  });
});
