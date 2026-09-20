import { beforeEach, expect, test } from "vitest";
import { configureDebugLogger } from "../observability/debug-logger.js";
import { buildAuditorDecisionInput } from "../steps/auditor-decision/input.js";
import type {
  AuditorAssignment,
  AuditorCapabilityEvidence,
} from "../steps/auditor-decision/contracts.js";
import { fingerprintAuditorEvidence } from "../steps/auditor-decision/evidence-inventory.js";
import { createAuditorRunnerFixture } from "./support/auditor-runner-fixture.js";

type RepresentedEvidence = Partial<AuditorCapabilityEvidence> & {
  representedFields?: Record<string, readonly (string | number)[]>;
};

beforeEach(() => configureDebugLogger({ enabled: false }));

function originalEvidence(): AuditorCapabilityEvidence {
  const body = "ORIGINAL_MUTATION_BODY:" + "x".repeat(17_000);
  const summary = "Committed the complete artifact.";
  const references = [
    { kind: "tool_target" as const, target: "task/index.html" },
  ];
  return {
    kind: "capability_result",
    executionId: "capability-execution-1",
    capabilityId: "fixture.write",
    declaredEffect: "mutation",
    outcome: "succeeded",
    observedEffect: "mutation",
    summary,
    referenceData: body,
    references,
    adapterResult: {
      kind: "registered_tool_execution_result_v1",
      authority: "registered_plugin",
      status: "executed",
      result: {
        ok: true,
        tool: "fixture.write",
        output: summary,
        producedNewInformation: true,
        data: { mutationGrounding: body },
      },
      references,
    },
  };
}

function reviewRepresentation(source: readonly AuditorCapabilityEvidence[]) {
  const { request } = createAuditorRunnerFixture(() => {
    throw new Error("unexpected_model_invocation");
  });
  const assignment: AuditorAssignment = {
    auditId: "call-2",
    callerCallId: "call-1",
    target: request.prompt,
    sourceRevision: 3,
    criterionIds: ["request_completion"],
    criteria: [
      {
        criterionId: "request_completion",
        description: "Verify the artifacts.",
      },
    ],
    workFingerprint: "unchanged-canonical-work",
    inventory: source.map((entry) => ({
      executionId: entry.executionId,
      callId: "call-1",
      invocationAttempt: 1,
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
      referenceCount: entry.references?.length ?? 0,
      omittedReferencePreviewCount: 0,
      exactEvidenceChars: JSON.stringify(entry).length,
      evidenceFingerprint: fingerprintAuditorEvidence(entry),
    })),
    selectedEvidenceIds: source.map(({ executionId }) => executionId),
    reviewedBundleFingerprints: [],
    reviewedEvidenceBundles: [],
    pendingEvidenceIds: null,
    evidence: source,
    availableEvidenceCount: source.length,
    omittedEvidenceCount: 0,
  };
  const input = buildAuditorDecisionInput(request, assignment, "review");
  const proof = input.context.messages
    .filter(({ role }) => role === "user")
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
  return proof.evidence as RepresentedEvidence[];
}

function resolvePath(
  root: unknown,
  path: readonly (string | number)[],
): unknown {
  return path.reduce<unknown>(
    (value, segment) => (value as Record<string | number, unknown>)[segment],
    root,
  );
}

test("represents exact registered mutation supplements once without changing original evidence", () => {
  const original = originalEvidence();
  const before = JSON.stringify(original);
  const fingerprint = fingerprintAuditorEvidence(original);
  const [represented] = reviewRepresentation([original]);
  expect(represented!.adapterResult).toEqual(original.adapterResult);
  expect(represented!.referenceData).toBeUndefined();
  expect(represented!.summary).toBeUndefined();
  expect(represented!.references).toBeUndefined();
  expect(represented!.representedFields).toEqual({
    summary: ["result", "output"],
    referenceData: ["result", "data", "mutationGrounding"],
    references: ["references"],
  });
  for (const [field, path] of Object.entries(represented!.representedFields!)) {
    expect(resolvePath(represented!.adapterResult, path)).toEqual(
      original[field as keyof AuditorCapabilityEvidence],
    );
  }
  expect(
    JSON.stringify(represented).split("ORIGINAL_MUTATION_BODY:"),
  ).toHaveLength(2);
  expect(JSON.stringify(original)).toBe(before);
  expect(fingerprintAuditorEvidence(original)).toBe(fingerprint);
});

test("finds exact generic nodes with literal object keys and array indices", () => {
  const original = originalEvidence();
  const generic: AuditorCapabilityEvidence = {
    ...original,
    adapterResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { "arbitrary/~": [original.referenceData!] },
    },
  };
  const [represented] = reviewRepresentation([generic]);
  expect(represented!.representedFields).toEqual({
    referenceData: ["payload", "arbitrary/~", 0],
  });
  expect(represented!.summary).toBe(original.summary);
  expect(represented!.references).toEqual(original.references);
  expect(represented!.adapterResult).toEqual(generic.adapterResult);
});

test("preserves nonidentical supplements, including whitespace and extra references", () => {
  const original = originalEvidence();
  const supplemented = {
    ...original,
    summary: original.summary + " ",
    referenceData: original.referenceData + "\n",
    references: [
      ...original.references!,
      { kind: "tool_target" as const, target: "extra.txt" },
    ],
  };
  const [represented] = reviewRepresentation([supplemented]);
  expect(represented!.representedFields).toBeUndefined();
  expect(represented).toEqual(supplemented);
});

test("never substitutes proof from another execution or rewrites duplicates inside the original adapter", () => {
  const original = originalEvidence();
  const other: AuditorCapabilityEvidence = {
    ...original,
    executionId: "capability-execution-2",
    adapterResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { unrelated: "another observation", repeated: ["same", "same"] },
    },
  };
  const [, represented] = reviewRepresentation([original, other]);
  expect(represented!.referenceData).toBe(other.referenceData);
  expect(represented!.adapterResult).toEqual(other.adapterResult);
  expect(represented!.representedFields).toBeUndefined();
});
