import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
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

const WINDOW = 12_000;
const AVAILABLE = WINDOW - 1_000 - 200;
const ASSIGNMENT = "runtime_execution_agent_auditor_assignment_v1";
const EVIDENCE = "runtime_execution_agent_auditor_evidence_v1";
type AuditReceipt = {
  verdict: string;
  reason?: string;
  evidenceBinding: { selectedEvidenceIds: string[]; workFingerprint: string };
};
type RootState = {
  auditAvailability: { available: boolean; reason: string };
  completedSubordinateResults: {
    roleId: string;
    outcome: string;
    summary: string;
  }[];
};
type BudgetCaseOptions = {
  reviewTokens?: readonly number[];
  proofChars?: number;
  repair?: boolean;
  bindingMismatch?: boolean;
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

function createBudgetCase(options: BudgetCaseOptions) {
  let rootDecisions = 0;
  let reviewAttempts = 0;
  let reviewCounts = 0;
  let finalState: RootState | undefined;
  const fixture = createAuditorRunnerFixture((input) => {
    if (input.modelStep === "execution.decision") {
      rootDecisions += 1;
      expect(
        auditMessages(input).filter(
          ({ role, content }) =>
            role === "user" && content === AUDIT_RUNNER_PROMPT,
        ),
      ).toHaveLength(1);
      if (rootDecisions <= 3) return auditRootPrelude(rootDecisions, 1);
      expect(rootDecisions).toBe(4);
      finalState = readAuditCapsule<RootState>(
        input,
        "runtime_execution_state_v1",
      );
      expect(finalState.auditAvailability).toMatchObject({
        available: false,
        reason: "audit_finished_for_work",
      });
      expect(JSON.stringify(input.format)).not.toContain('"invoke_auditor"');
      expect(JSON.stringify(input.format)).toContain('"respond"');
      return { action: "respond" };
    }
    expect(input.modelStep).toBe("auditor.decision");
    const assignment = readAuditCapsule<{ auditId: string }>(input, ASSIGNMENT);
    const selectedEvidenceIds = fixture.records.map(
      ({ executionId }) => executionId,
    );
    if (auditFormatName(input) === "auditor_evidence_selection") {
      return { auditId: assignment.auditId, selectedEvidenceIds };
    }
    expect(auditFormatName(input)).toBe("auditor_decision");
    assertExactProof(input);
    reviewAttempts += 1;
    const needsRepair = options.repair && reviewAttempts === 1;
    return {
      auditId: needsRepair ? "unknown-audit" : assignment.auditId,
      verdict: "pass",
      criterionIds: AUDIT_CRITERION_IDS,
      gaps: [],
      neededEvidenceIds: selectedEvidenceIds,
      notNeededEvidenceIds: [],
      requestedEvidenceIds: [],
    };
  }, 1);
  fixture.records[0]!.exactResult.payload.referenceData =
    "EXACT_ORIGINAL:" + "x".repeat(options.proofChars ?? 50_000);
  const canonicalProof = structuredClone(fixture.records[0]!.exactResult);
  function assertExactProof(input: AuditRunnerInput) {
    const proof = readAuditCapsule<{
      evidence: { executionId: string; adapterResult: unknown }[];
      evidenceProjection: { complete: boolean; omittedEvidenceCount: number };
    }>(input, EVIDENCE);
    expect(proof.evidence).toHaveLength(1);
    expect(proof.evidence[0]).toMatchObject({
      executionId: fixture.records[0]!.executionId,
      adapterResult: canonicalProof,
    });
    expect(proof.evidence[0]!.adapterResult).toEqual(canonicalProof);
    expect(proof.evidenceProjection).toMatchObject({
      complete: true,
      omittedEvidenceCount: 0,
    });
  }
  const countInputTokens = vi.fn<
    NonNullable<ModelGatewayClient["countInputTokens"]>
  >(async (input) => {
    if (input.modelStep !== "auditor.decision") return undefined;
    const isReview = auditFormatName(input) === "auditor_decision";
    if (isReview) {
      assertExactProof(input);
      reviewCounts += 1;
    }
    if (!options.reviewTokens) return undefined;
    const reviewTokenIndex = Math.min(
      reviewCounts - 1,
      options.reviewTokens.length - 1,
    );
    return {
      inputTokens: isReview ? options.reviewTokens[reviewTokenIndex]! : 2_000,
      profileId:
        isReview && options.bindingMismatch ? "other-profile" : "audit-native",
      provider: "ollama",
      model: "audit-native",
      contextWindowTokens: WINDOW,
      source: "provider_input_token_count",
    };
  });
  const onEvent = vi.fn();
  const request = deriveTestRequestExecutionScope(fixture.request, {
    modelGatewayClient: {
      ...fixture.request.modelGatewayClient,
      countInputTokens,
    },
    onEvent,
    modelPolicy: {
      ...fixture.request.modelPolicy,
      profiles: {
        ...fixture.request.modelPolicy?.profiles,
        "audit-native": {
          provider: "local",
          model: "audit-native",
          contextWindowTokens: WINDOW,
        },
      },
      defaults: {
        profileId: "audit-test",
        steps: { "auditor.decision": "audit-native" },
      },
    },
  });
  return {
    ...fixture,
    request,
    countInputTokens,
    onEvent,
    reviewCounts: () => reviewCounts,
    reviewAttempts: () => reviewAttempts,
    finalResult: () => finalState!.completedSubordinateResults[0]!,
    receipt: () =>
      JSON.parse(
        finalState!.completedSubordinateResults[0]!.summary,
      ) as AuditReceipt,
    snapshots: () =>
      onEvent.mock.calls
        .filter(
          ([name, data]) =>
            name === "context.window.snapshot" &&
            data.modelStep === "auditor.decision",
        )
        .map(([, data]) => data as Record<string, unknown>),
  };
}

async function expectCompletedAudit(
  fixture: ReturnType<typeof createBudgetCase>,
  verdict: "pass" | "failed",
  reviewCalls: number,
) {
  await expect(runRequestRunner(fixture.request)).resolves.toMatchObject({
    output: AUDIT_RUNNER_FINAL,
  });
  expect(fixture.finalResult()).toMatchObject({
    roleId: "reviewer",
    outcome: verdict === "pass" ? "completed" : "failed",
  });
  expect(fixture.receipt()).toMatchObject({
    verdict,
    evidenceBinding: {
      selectedEvidenceIds: [fixture.records[0]!.executionId],
      workFingerprint: expect.any(String),
    },
  });
  expect(fixture.reviewAttempts()).toBe(reviewCalls);
  expect(fixture.execute).toHaveBeenCalledOnce();
  expect(fixture.invokeRaw).not.toHaveBeenCalled();
  expect(fixture.request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
    AUDIT_RUNNER_FINAL,
  );
  expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    "execution.decision",
    "execution.decision",
    "execution.decision",
    "auditor.decision",
    ...Array.from({ length: reviewCalls }, () => "auditor.decision"),
    "execution.decision",
    "execution.response",
  ]);
  expectNoAuditorCompaction(fixture);
}

function expectNoAuditorCompaction(
  fixture: ReturnType<typeof createBudgetCase>,
) {
  expect(
    fixture.onEvent.mock.calls.filter(
      ([name, data]) =>
        name.startsWith("context.compaction.") &&
        data?.modelStep === "auditor.decision",
    ),
  ).toEqual([]);
}

function expectReservedBudget(
  snapshot: Record<string, unknown>,
  measuredTokens: number,
) {
  expect(snapshot).toMatchObject({
    contextWindowTokens: WINDOW,
    availableInputTokens: AVAILABLE,
    outputReserveTokens: 1_000,
    safetyReserveTokens: 200,
    measuredInputTokens: measuredTokens,
    measurement: "actual",
    source: "provider_input_token_count",
    compactionTriggerEligible: false,
    compactionRequired: false,
  });
}

describe("Auditor native context admission through the request runner", () => {
  test.each([8_000, 10_000, AVAILABLE])(
    "admits unchanged exact proof measured at %i tokens despite an over-budget estimate",
    async (reviewTokens) => {
      const fixture = createBudgetCase({ reviewTokens: [reviewTokens] });
      await expectCompletedAudit(fixture, "pass", 1);
      expect(fixture.reviewCounts()).toBe(1);
      const snapshot = fixture.snapshots().at(-1)!;
      expectReservedBudget(snapshot, reviewTokens);
      expect(snapshot.admissionOutcome).toBe("accepted");
      expect(snapshot.estimatedInputTokens).toBeGreaterThan(AVAILABLE);
      const [countedReview] = fixture.countInputTokens.mock.calls.filter(
        ([input]) => auditFormatName(input) === "auditor_decision",
      );
      const [invokedReview] = fixture.invoke.mock.calls.filter(
        ([input]) => auditFormatName(input) === "auditor_decision",
      );
      expect(invokedReview![0].messages).toEqual(countedReview![0].messages);
      expect(invokedReview![0].format).toEqual(countedReview![0].format);
    },
  );

  test("returns failed advisory without review dispatch when native input consumes reserved capacity", async () => {
    const fixture = createBudgetCase({ reviewTokens: [AVAILABLE + 1] });
    await expectCompletedAudit(fixture, "failed", 0);
    expect(fixture.reviewCounts()).toBe(1);
    expect(fixture.receipt().reason).toBe(
      "auditor_exact_context_exceeds_budget",
    );
    const snapshot = fixture.snapshots().at(-1)!;
    expectReservedBudget(snapshot, AVAILABLE + 1);
    expect(snapshot.admissionOutcome).toBe("rejected");
  });

  test.each([
    { proofChars: 50_000, verdict: "failed", reviews: 0 },
    { proofChars: 1_000, verdict: "pass", reviews: 1 },
  ] as const)(
    "uses the estimator safely when native count is unavailable: $verdict",
    async ({ proofChars, verdict, reviews }) => {
      const fixture = createBudgetCase({ proofChars });
      await expectCompletedAudit(fixture, verdict, reviews);
      expect(fixture.reviewCounts()).toBe(1);
      const snapshot = fixture.snapshots().at(-1)!;
      expect(snapshot).toMatchObject({
        measurement: "estimated",
        source: "runtime_token_estimator",
        availableInputTokens: AVAILABLE,
        admissionOutcome: verdict === "pass" ? "accepted" : "rejected",
      });
      expect(snapshot.measuredInputTokens).toBeUndefined();
      if (verdict === "failed")
        expect(fixture.receipt().reason).toBe(
          "auditor_exact_context_exceeds_budget",
        );
    },
  );

  test("admits estimator-only exact proof above the compaction trigger but inside the reserved budget", async () => {
    const fixture = createBudgetCase({ proofChars: 10_000 });
    await expectCompletedAudit(fixture, "pass", 1);
    const snapshot = fixture.snapshots().at(-1)!;
    expect(snapshot.estimatedInputTokens).toBeGreaterThanOrEqual(WINDOW * 0.7);
    expect(snapshot.estimatedInputTokens).toBeLessThanOrEqual(AVAILABLE);
    expect(snapshot).toMatchObject({
      measurement: "estimated",
      source: "runtime_token_estimator",
      admissionOutcome: "accepted",
      compactionTriggerEligible: false,
      compactionRequired: false,
    });
  });

  test.each([
    { secondTokens: 10_500, verdict: "pass", reviews: 2 },
    { secondTokens: AVAILABLE + 1, verdict: "failed", reviews: 1 },
  ] as const)(
    "recounts the complete repair envelope while preserving exact retention: $verdict",
    async ({ secondTokens, verdict, reviews }) => {
      const fixture = createBudgetCase({
        reviewTokens: [10_000, secondTokens],
        repair: true,
      });
      await expectCompletedAudit(fixture, verdict, reviews);
      expect(fixture.reviewCounts()).toBe(2);
      const counted = fixture.countInputTokens.mock.calls.filter(
        ([input]) => auditFormatName(input) === "auditor_decision",
      );
      expect(auditMessages(counted[1]![0]).length).toBeGreaterThan(
        auditMessages(counted[0]![0]).length,
      );
      expectReservedBudget(fixture.snapshots().at(-1)!, secondTokens);
    },
  );

  test("rejects a count bound to another profile before review provider dispatch", async () => {
    const fixture = createBudgetCase({
      reviewTokens: [8_000],
      bindingMismatch: true,
    });
    await expect(runRequestRunner(fixture.request)).rejects.toThrow(
      "model_input_token_count_binding_mismatch",
    );
    expect(fixture.reviewCounts()).toBe(1);
    expect(fixture.reviewAttempts()).toBe(0);
    expect(
      fixture.invoke.mock.calls.filter(
        ([input]) => input.modelStep === "auditor.decision",
      ),
    ).toHaveLength(1);
    expectNoAuditorCompaction(fixture);
  });
});
