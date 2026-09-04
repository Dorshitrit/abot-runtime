import { describe, expect, test } from "vitest";
import { projectOllamaFormat } from "../../model-gateway/structured-output.js";
import {
  buildReviewerDecisionInstructions,
  createReviewerDecisionFormat,
  parseReviewerDecisionOutput,
  type ReviewerReviewSnapshot,
} from "../steps/reviewer-decision/index.js";

const artifactEvidence = [
  ["evidence-html", "project/index.html"],
  ["evidence-css", "project/styles.css"],
  ["evidence-js", "project/app.js"],
  ["evidence-data", "project/products.json"],
] as const;

const snapshot: ReviewerReviewSnapshot = {
  reviewScopeId: "review:call-reviewer:r20",
  reviewerCallId: "call-reviewer",
  callerCallId: "call-planner",
  sourceRevision: 20,
  projectionComplete: true,
  freshness: "current",
  allowedGapKinds: [
    "state_mismatch",
    "missing_artifact",
    "missing_evidence",
  ],
  subjects: [
    {
      subjectRef: "call:call-planner",
      kind: "caller_objective",
      summary: "Create one integrated product page from four artifacts.",
    },
  ],
  facts: [],
  evidence: artifactEvidence.map(([evidenceRef, target]) => ({
    evidenceRef,
    kind: "capability_execution",
    outcome: "succeeded",
    effect: "mutation",
    subjectRefs: ["call:call-planner"],
    summary: `Created ${target}.`,
    references: [{ kind: "tool_target", target }],
    referenceData: target,
  })),
};
const verifiedSnapshot: ReviewerReviewSnapshot = {
  ...snapshot,
  facts: snapshot.evidence.map(({ evidenceRef }, index) => ({
    factRef: `fact-verified-${index}`,
    kind: "artifact_verification",
    status: "satisfied",
    subjectRefs: ["call:call-planner"],
    evidenceRefs: [evidenceRef],
    summary: "A canonical verifier accepted the current artifact.",
  })),
};

function audit(
  options: Readonly<{
    contradictionRef?: string;
    completionStatus?: "satisfied" | "gap" | "indeterminate";
    completionEvidenceRefs?: readonly string[];
  }> = {},
) {
  return {
    evidenceAssessments: snapshot.evidence.map(({ evidenceRef }) => ({
      evidenceRef,
      status:
        evidenceRef === options.contradictionRef ? "contradicts" : "supports",
      finding:
        evidenceRef === options.contradictionRef
          ? "The JavaScript target does not exist in the current HTML."
          : "The current artifact supports its bounded requirement.",
    })),
    completionAssessment: {
      status: options.completionStatus ?? "satisfied",
      evidenceRefs:
        options.completionEvidenceRefs ??
        snapshot.evidence.map(({ evidenceRef }) => evidenceRef),
      finding:
        options.completionStatus === "gap"
          ? "The HTML and JavaScript integration edge is mismatched."
          : "All requested artifacts and their integration edges are established.",
    },
  };
}

function encode(decision: Record<string, unknown>): string {
  return JSON.stringify({ decision });
}

describe("Reviewer audit coverage", () => {
  test("requires one assessment per supplied evidence item and synthesis across multiple items", () => {
    const format = createReviewerDecisionFormat(verifiedSnapshot);
    const variants = (
      format.schema as {
        properties: {
          decision: {
            anyOf: readonly {
              properties: {
                audit: {
                  properties: {
                    evidenceAssessments: { minItems: number; maxItems: number };
                    completionAssessment: {
                      properties: { evidenceRefs: { minItems: number } };
                    };
                  };
                };
              };
            }[];
          };
        };
      }
    ).properties.decision.anyOf;

    expect(variants[0]!.properties.audit.properties.evidenceAssessments).toEqual(
      expect.objectContaining({ minItems: 4, maxItems: 4 }),
    );
    expect(
      variants[0]!.properties.audit.properties.completionAssessment.properties
        .evidenceRefs.minItems,
    ).toBe(2);
    expect(projectOllamaFormat(format).diagnostics.length).toBeGreaterThan(0);
  });

  test("removes and defensively rejects pass for unverified multi-target mutations", () => {
    const format = createReviewerDecisionFormat(snapshot);
    const instructions = buildReviewerDecisionInstructions();
    const decisionSchema = (
      format.schema as {
        properties: {
          decision: {
            anyOf?: unknown;
            properties: { action: { enum: readonly string[] } };
          };
        };
      }
    ).properties.decision;
    const parsed = parseReviewerDecisionOutput(
      encode({
        action: "pass",
        reviewScopeId: snapshot.reviewScopeId,
        audit: audit(),
        summary: "Completion is established.",
        gaps: [],
      }),
      { snapshot },
    );

    expect(decisionSchema.anyOf).toBeUndefined();
    expect(decisionSchema.properties.action.enum).toEqual(["report_gaps"]);
    expect(instructions).toContain("gap.kind set to missing_evidence");
    expect(instructions).not.toContain("missing-verification gap");
    expect(parsed).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: "reviewer_pass_verification_incomplete",
        }),
      ],
    });
    expect(
      parseReviewerDecisionOutput(
        encode({
          action: "report_gaps",
          reviewScopeId: snapshot.reviewScopeId,
          audit: audit({ completionStatus: "gap" }),
          summary: "Current verification evidence is incomplete.",
          gaps: [
            {
              kind: "missing_evidence",
              subjectRefs: ["call:call-planner"],
              factRefs: [],
              evidenceRefs: [],
              summary: "Current verification is missing for listed targets.",
            },
          ],
        }),
        { snapshot },
      ),
    ).toMatchObject({
      ok: true,
      decision: { action: "report_gaps" },
    });
  });

  test("rejects pass when the audit is absent or does not cover the exact evidence set", () => {
    const decision = {
      action: "pass",
      reviewScopeId: snapshot.reviewScopeId,
      summary: "Completion is established.",
      gaps: [],
    };
    const missingAudit = parseReviewerDecisionOutput(encode(decision), {
      snapshot,
    });
    const incompleteAudit = audit();
    incompleteAudit.evidenceAssessments.pop();
    const missingEvidence = parseReviewerDecisionOutput(
      encode({ ...decision, audit: incompleteAudit }),
      { snapshot },
    );

    expect(missingAudit).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "reviewer_decision_shape_invalid" }),
        expect.objectContaining({ code: "reviewer_audit_invalid" }),
      ]),
    });
    expect(missingEvidence).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "reviewer_evidence_assessment_coverage_invalid",
        }),
      ]),
    });
  });

  test("rejects a pass verdict that contradicts its own artifact audit", () => {
    const parsed = parseReviewerDecisionOutput(
      encode({
        action: "pass",
        reviewScopeId: snapshot.reviewScopeId,
        audit: audit({
          contradictionRef: "evidence-js",
          completionStatus: "gap",
        }),
        summary: "Completion is established.",
        gaps: [],
      }),
      { snapshot },
    );
    expect(parsed).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "reviewer_pass_audit_gap" }),
      ]),
    });
  });

  test("accepts the same visible integration mismatch only as a gap verdict", () => {
    const mismatchAudit = audit({
      contradictionRef: "evidence-js",
      completionStatus: "gap",
    });
    mismatchAudit.completionAssessment.finding = "mismatch ".repeat(100);
    const parsed = parseReviewerDecisionOutput(
      encode({
        action: "report_gaps",
        reviewScopeId: snapshot.reviewScopeId,
        audit: mismatchAudit,
        summary: "One integration gap remains.",
        gaps: [
          {
            kind: "state_mismatch",
            subjectRefs: ["call:call-planner"],
            factRefs: [],
            evidenceRefs: ["evidence-js"],
            summary: "The JavaScript target is absent from the current HTML.",
          },
        ],
      }),
      { snapshot },
    );
    expect(parsed).toMatchObject({
      ok: true,
      decision: { action: "report_gaps" },
    });
  });
});
