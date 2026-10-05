import { afterEach, beforeEach, expect, test } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { resolveExecutionCompactedSources } from "../context/execution-compacted-evidence.js";
import { buildAuditorDecisionInput } from "../steps/auditor-decision/input.js";
import { projectAuditorEvidenceRepresentation } from "../steps/auditor-decision/evidence-representation.js";
import { fingerprintAuditorEvidence } from "../steps/auditor-decision/evidence-inventory.js";
import type {
  AuditorAssignment,
  AuditorCapabilityEvidence,
} from "../steps/auditor-decision/contracts.js";
import { createAuditorRunnerFixture } from "./support/auditor-runner-fixture.js";
import {
  compactedSourceFixture,
  settledSource,
} from "./support/compacted-execution-source-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(resetDebugLoggerConfig);

function auditorFixture() {
  const covered = settledSource("covered");
  const unselected = settledSource("unselected");
  const fresh = settledSource("fresh", "NEW_RAW_EVIDENCE");
  const f = compactedSourceFixture([covered, unselected]);
  const originals: AuditorCapabilityEvidence[] = [
    covered,
    unselected,
    fresh,
  ].map((result) => ({ kind: "capability_result", ...result }));
  const assignment: AuditorAssignment = {
    auditId: "audit-1",
    callerCallId: "call-1",
    target: "Audit the accepted artifact.",
    sourceRevision: 8,
    criterionIds: ["request_completion"],
    criteria: [
      {
        criterionId: "request_completion",
        description: "Verify established facts.",
      },
    ],
    workFingerprint: "canonical-original-work",
    reviewedBundleFingerprints: [],
    reviewedEvidenceBundles: [],
    pendingEvidenceIds: null,
    availableEvidenceCount: 3,
    omittedEvidenceCount: 0,
    selectedEvidenceIds: ["covered", "fresh"],
    evidence: [originals[0]!, originals[2]!],
    compactedSourceEvidence: resolveExecutionCompactedSources(f.resolver),
    inventory: originals.map((entry) => ({
      executionId: entry.executionId,
      callId: "call-1",
      invocationAttempt: 2,
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
  };
  const { request } = createAuditorRunnerFixture(() => {
    throw new Error("model_must_not_run");
  });
  return { f, originals, assignment, request };
}

function evidenceCapsule(input: ReturnType<typeof buildAuditorDecisionInput>) {
  return input.context.messages
    .map(({ content }) => {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    })
    .find(
      (value) => value?.kind === "runtime_execution_agent_auditor_evidence_v1",
    );
}

test("Auditor receives only selected verified digests and newly gathered exact evidence", () => {
  const { assignment, request, originals } = auditorFixture();
  const before = JSON.stringify(originals);
  const input = buildAuditorDecisionInput(request, assignment, "review");
  const capsule = evidenceCapsule(input);
  expect(
    capsule.evidence.map((entry: { executionId: string }) => entry.executionId),
  ).toEqual(["covered", "fresh"]);
  expect(capsule.evidence[0].compactedSourceEvidence).toMatchObject({
    executionId: "covered",
    digest: "DIGEST_covered",
    authority: "passive_reference_only",
  });
  expect(capsule.evidence[0]).not.toHaveProperty("adapterResult");
  expect(capsule.evidence[1].adapterResult).toEqual(
    originals[2]!.adapterResult,
  );
  expect(capsule.evidence[1].referenceData).toBe("NEW_RAW_EVIDENCE");
  expect(input.reusedCompactedSourceCount).toBe(1);
  expect(JSON.stringify(input.context.messages)).not.toContain(
    "DIGEST_unselected",
  );
  expect(JSON.stringify(input.context.messages)).not.toContain(
    "ROOT_CONTINUATION",
  );
  expect(JSON.stringify(originals)).toBe(before);
  expect(capsule.evidenceProjection.complete).toBe(true);
});

test("Auditor selection has no source bodies and an unrelated digest cannot replace an original", () => {
  const { assignment, request, originals } = auditorFixture();
  const selection = buildAuditorDecisionInput(request, assignment, "selection");
  expect(evidenceCapsule(selection)).toBeUndefined();
  expect(selection.reusedCompactedSourceCount).toBe(0);
  expect(JSON.stringify(selection.context.messages)).not.toContain("DIGEST_");
  const wrongDigest = {
    ...assignment.compactedSourceEvidence!.sources[0]!,
    executionId: "other",
  };
  expect(
    projectAuditorEvidenceRepresentation(originals[0]!, wrongDigest),
  ).toEqual(projectAuditorEvidenceRepresentation(originals[0]!));
});

test("Auditor compacted projection must not resurrect the same covered mutation body via referenceData", () => {
  const { assignment, request } = auditorFixture();
  const input = buildAuditorDecisionInput(request, assignment, "review");
  const covered = evidenceCapsule(input).evidence[0];
  expect(covered).not.toHaveProperty("referenceData");
  expect(JSON.stringify(covered)).not.toContain("COVERED_BODY");
});

test("Auditor compacted projection preserves independent supplement evidence", () => {
  const { assignment, originals } = auditorFixture();
  const original = {
    ...originals[0]!,
    referenceData: "INDEPENDENT_SUPPLEMENT",
  };
  const projected = projectAuditorEvidenceRepresentation(
    original,
    assignment.compactedSourceEvidence!.sources[0],
  );
  expect(projected.referenceData).toBe("INDEPENDENT_SUPPLEMENT");
});
