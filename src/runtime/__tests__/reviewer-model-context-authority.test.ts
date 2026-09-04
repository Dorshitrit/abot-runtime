import { describe, expect, test } from "vitest";

import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import type { ReviewerReviewSnapshot } from "../steps/reviewer-decision/contracts.js";
import { projectReviewerModelContext } from "../steps/reviewer-decision/model-context.js";

const COMPLETION_TARGET = "Audit the exact requested completion target.";

const reviewerCall: RoleCallFrame = Object.freeze({
  callId: "call-reviewer",
  parentCallId: "call-supervisor",
  roleId: "reviewer",
  depth: 1,
  objective: COMPLETION_TARGET,
  dependencyResultRefs: Object.freeze([]),
  status: "active",
  childCallIds: Object.freeze([]),
  activationCount: 1,
  resultRef: null,
});

const snapshot: ReviewerReviewSnapshot = Object.freeze({
  reviewScopeId: "review:call-reviewer:r7",
  reviewerCallId: reviewerCall.callId,
  callerCallId: reviewerCall.parentCallId!,
  sourceRevision: 7,
  projectionComplete: true,
  freshness: "current",
  allowedGapKinds: Object.freeze(["incomplete_outcome"]),
  subjects: Object.freeze([
    Object.freeze({
      subjectRef: "call:call-supervisor",
      kind: "caller_objective",
      summary: COMPLETION_TARGET,
    }),
  ]),
  facts: Object.freeze([]),
  evidence: Object.freeze([]),
});

describe("Reviewer model-context authority", () => {
  test("projects one canonical completion target without assignment prose", () => {
    const projection = projectReviewerModelContext(snapshot, reviewerCall);
    const capsule = JSON.parse(projection.prompt) as Record<string, unknown>;
    const assignment = capsule.assignment as Record<string, unknown>;

    expect(assignment).toMatchObject({
      authority: "canonical_reviewer_call",
      callId: reviewerCall.callId,
      purpose: "audit_supplied_completion_target",
      completionTargetRef: "call:call-supervisor",
    });
    expect(assignment).not.toHaveProperty("text");
    expect(assignment).not.toHaveProperty("objective");
    expect(capsule.completionTarget).toEqual({
      authority: "caller",
      subjectRef: "call:call-supervisor",
      text: COMPLETION_TARGET,
    });
    expect(projection.prompt.split(COMPLETION_TARGET)).toHaveLength(2);
  });
});
