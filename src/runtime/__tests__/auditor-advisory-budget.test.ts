import { describe, expect, test } from "vitest";
import { ROLE_CALL_RESULT_MAX_LENGTH } from "../orchestration/role-calls/index.js";
import type {
  AuditorAssignment,
  AuditorDecision,
} from "../steps/auditor-decision/contracts.js";
import {
  failedAuditorAdvisory,
  settleAuditorAdvisory,
} from "../steps/auditor-decision/advisory-receipt.js";
import { createAuditorDecisionFormat } from "../steps/auditor-decision/format.js";
import { parseAuditorDecisionOutput } from "../steps/auditor-decision/parser.js";

function assignment(count = 2, criterionCount = 1): AuditorAssignment {
  const ids = Array.from(
    { length: count },
    (_, index) => `capability-execution-${index + 1}`,
  );
  const criterionIds =
    criterionCount === 1
      ? ["request_completion"]
      : Array.from(
          { length: criterionCount },
          (_, index) => `criterion-${index + 1}`,
        );
  const evidence = ids.slice(0, -1).map((executionId) => ({
    kind: "capability_result" as const,
    executionId,
    capabilityId: "fixture.observe",
    declaredEffect: "observation" as const,
    outcome: "succeeded" as const,
    observedEffect: "observation" as const,
    summary: "Observed.",
    adapterResult: {
      kind: "generic_capability_result_v1" as const,
      authority: "capability_adapter" as const,
      status: "executed" as const,
      ok: true,
      payload: {},
    },
  }));
  return {
    auditId: "call-48",
    callerCallId: "call-1",
    target: "Audit work.",
    sourceRevision: 10,
    criterionIds,
    criteria: criterionIds.map((criterionId) => ({
      criterionId,
      description: "Inspect work.",
    })),
    workFingerprint: "a".repeat(64),
    inventory: ids.map((executionId) => ({
      executionId,
      callId: "call-1",
      invocationAttempt: 1,
      capabilityId: "fixture.observe",
      declaredEffect: "observation",
      outcome: "succeeded",
      observedEffect: "observation",
      summaryPreview: { text: "Observed.", originalChars: 9, truncated: false },
      targetPreviews: [],
      referenceCount: 0,
      omittedReferencePreviewCount: 0,
      exactEvidenceChars: 100,
      evidenceFingerprint: "b".repeat(64),
    })),
    selectedEvidenceIds: ids.slice(0, -1),
    reviewedBundleFingerprints: [],
    reviewedEvidenceBundles: [],
    pendingEvidenceIds: null,
    evidence,
    availableEvidenceCount: count,
    omittedEvidenceCount: 0,
  };
}

function decision(
  bound: AuditorAssignment,
  description: string,
): AuditorDecision {
  const ids = bound.inventory.map(({ executionId }) => executionId);
  return {
    auditId: bound.auditId,
    verdict: "needs_evidence",
    criterionIds: bound.criterionIds,
    gaps: bound.criterionIds.map((criterionId) => ({
      criterionId,
      description,
    })),
    neededEvidenceIds: ids,
    notNeededEvidenceIds: [],
    requestedEvidenceIds: ids,
  };
}

function descriptionLimit(bound: AuditorAssignment): number {
  const format = createAuditorDecisionFormat(bound);
  const matches = JSON.stringify(format.schema).matchAll(/"maxLength":(\d+)/gu);
  const limits = [...matches].map((match) => Number(match[1]));
  expect(limits.length).toBeGreaterThan(0);
  expect(new Set(limits).size).toBe(1);
  return limits[0]!;
}

function parse(bound: AuditorAssignment, value: AuditorDecision) {
  return parseAuditorDecisionOutput(JSON.stringify({ decision: value }), bound);
}

describe("Auditor advisory result envelope budget", () => {
  test.each([2, 96])(
    "every offered escaped description fits with all %i inventory IDs",
    (count) => {
      const bound = assignment(count);
      const limit = descriptionLimit(bound);
      const value = decision(bound, "\u0001".repeat(limit));
      expect(parse(bound, value)).toMatchObject({ ok: true });
      const receipt = settleAuditorAdvisory(bound, value);
      expect(receipt.outcome).toBe("completed");
      expect(receipt.summary.length).toBeLessThanOrEqual(
        ROLE_CALL_RESULT_MAX_LENGTH,
      );
      expect(JSON.parse(receipt.summary)).toMatchObject({
        verdict: "needs_evidence",
        neededEvidenceIds: value.neededEvidenceIds,
        requestedEvidenceIds: value.requestedEvidenceIds,
        evidenceBinding: { selectedEvidenceIds: bound.selectedEvidenceIds },
      });
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThan(8192);
    },
  );

  test.each(["x", "\u0001", "\\", '"', "\ud800", "\u{1f680}"])(
    "schema limit and parser agree for %j and reject one extra Unicode code point",
    (character) => {
      const bound = assignment();
      const limit = descriptionLimit(bound);
      const value = decision(bound, character.repeat(limit));
      expect(parse(bound, value)).toMatchObject({ ok: true });
      expect(settleAuditorAdvisory(bound, value).outcome).toBe("completed");
      expect(
        parse(bound, decision(bound, character.repeat(limit + 1))),
      ).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "auditor_gap_description_invalid" }),
        ]),
      });
    },
  );

  test.each([8, 32])(
    "accounts for %i criteria and rejects metadata-only overflow before review",
    (criterionCount) => {
      const single = assignment();
      const multiple = assignment(2, criterionCount);
      expect(descriptionLimit(multiple)).toBeLessThan(
        descriptionLimit(single) / criterionCount,
      );
      const value = decision(
        multiple,
        "\u0001".repeat(descriptionLimit(multiple)),
      );
      expect(parse(multiple, value)).toMatchObject({ ok: true });
      expect(settleAuditorAdvisory(multiple, value).outcome).toBe("completed");
      expect(() => createAuditorDecisionFormat(assignment(192))).toThrow(
        "auditor_result_metadata_exceeds_budget",
      );
      const failure = failedAuditorAdvisory(
        {
          ...assignment(192),
          selectedEvidenceIds: assignment(192).inventory.map(
            ({ executionId }) => executionId,
          ),
        },
        "auditor_result_metadata_exceeds_budget",
      );
      expect(failure.summary.length).toBeLessThanOrEqual(
        ROLE_CALL_RESULT_MAX_LENGTH,
      );
      expect(
        JSON.parse(failure.summary).evidenceBinding.selectedEvidenceIds,
      ).toHaveLength(192);
    },
  );

  test("fits the exact serialized boundary and rejects the next description unit", () => {
    const original = assignment();
    const sample = settleAuditorAdvisory(original, decision(original, ""));
    const remainder = (ROLE_CALL_RESULT_MAX_LENGTH - sample.summary.length) % 6;
    const bound = {
      ...original,
      auditId: original.auditId + "x".repeat(remainder),
    };
    const limit = descriptionLimit(bound);
    const receipt = settleAuditorAdvisory(
      bound,
      decision(bound, "\u0001".repeat(limit)),
    );
    expect(receipt.outcome).toBe("completed");
    expect(receipt.summary).toHaveLength(ROLE_CALL_RESULT_MAX_LENGTH);
    expect(
      parse(bound, decision(bound, "\u0001".repeat(limit + 1))),
    ).toMatchObject({ ok: false });
  });

  test("preserves pass and gaps with exact admitted proof and full inventory coverage", () => {
    const bound = assignment();
    const ids = bound.inventory.map(({ executionId }) => executionId);
    for (const verdict of ["pass", "gaps"] as const) {
      const value = {
        ...decision(bound, "\u0001".repeat(descriptionLimit(bound))),
        verdict,
        neededEvidenceIds: ids.slice(0, 1),
        notNeededEvidenceIds: ids.slice(1),
        requestedEvidenceIds: [],
        gaps:
          verdict === "pass"
            ? []
            : decision(bound, "\u0001".repeat(descriptionLimit(bound))).gaps,
      };
      const parsed = parse(bound, value);
      expect(parsed).toMatchObject({ ok: true });
      expect(settleAuditorAdvisory(bound, value).outcome).toBe("completed");
    }
  });
});
