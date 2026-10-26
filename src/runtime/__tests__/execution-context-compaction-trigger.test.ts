import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { MODEL_STEPS, type ModelStep } from "../../shared/model-steps.js";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import { projectPinnedContext } from "../context/pinned-context-compaction.js";
import { resolveModelContextBudget } from "../model/model-context-budget.js";
import { requiresContextCompaction } from "../model/context-compaction-admission.js";
import {
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

const EA_STEPS = ["execution.decision", "execution.response"] as const;

function messageWithEstimatedTokens(tokens: number): ChatMessage {
  return { role: "system", content: "x".repeat((tokens - 6) * 2) };
}

function budgetForStep(modelStep: ModelStep) {
  const { request } = createAdmissionFixture({
    modelStep, contextWindowTokens: 100_000,
  });
  return resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep,
    modelPolicy: request.modelPolicy,
  });
}

describe.each(EA_STEPS)("%s compaction trigger", (modelStep) => {
  test.each([
    ["estimated", 80_000], ["estimated", 89_999],
    ["estimated", 90_000], ["estimated", 91_000],
    ["measured", 80_000], ["measured", 89_999],
    ["measured", 90_000], ["measured", 91_000],
  ] as const)("%s input at %i tokens uses the 90 percent boundary", async (measurement, inputTokens) => {
    const harness = createAdmissionFixture({
      modelStep, contextWindowTokens: 100_000,
      counts: [inputTokens, 80_000], estimatorOnly: measurement === "estimated",
    });
    const stage = createAdmissionStage("active_request", "checkpoint");
    stage.prepare.mockResolvedValue({
      kind: "prepared",
      preparation: {
        messages: [messageWithEstimatedTokens(80_000)],
        scopeId: stage.scopeId, sourceRevision: 1, coveredSourceCount: 1,
        commit: stage.commit,
      },
    });
    await expect(harness.invoker.invoke({
      modelStep,
      messages: [messageWithEstimatedTokens(inputTokens)],
      timeoutReason: "test_timeout",
      contextCompaction: createAdmissionController([stage]),
      accept: (text) => text,
    })).resolves.toBe("ok");
    const expectedCompactions = inputTokens >= 90_000 ? 1 : 0;
    expect(stage.prepare).toHaveBeenCalledTimes(expectedCompactions);
    expect(stage.commit).toHaveBeenCalledTimes(expectedCompactions);
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.events).toContainEqual([
      "context.window.snapshot",
      expect.objectContaining({
        compactionTriggerPercent: 90, compactionTriggerInputTokens: 90_000,
        measurement: measurement === "measured" ? "actual" : "estimated",
        admissionOutcome: "accepted",
      }),
    ]);
  });

  test("reuses verified evidence above 90 percent while still within the hard limit", async () => {
    const harness = createAdmissionFixture({
      modelStep, contextWindowTokens: 100_000, counts: [91_000],
    });
    const stage = createAdmissionStage("active_request", "unused");
    const proof = vi.fn(() => true);
    await expect(harness.run({
      ...createAdmissionController([stage]),
      hasExhaustedVerifiedCompactionSources: proof,
    })).resolves.toBe("ok");
    expect(proof).toHaveBeenCalledOnce();
    expect(stage.prepare).not.toHaveBeenCalled();
    expect(harness.invoke).toHaveBeenCalledOnce();
  });

  test("compacts at the hard input ceiling even below 90 percent", async () => {
    const harness = createAdmissionFixture({ modelStep, counts: [26_705, 26_000] });
    const stage = createAdmissionStage("active_request", "checkpoint");
    await expect(harness.run(createAdmissionController([stage]))).resolves.toBe("ok");
    expect(stage.prepare).toHaveBeenCalledOnce();
    expect(stage.commit).toHaveBeenCalledOnce();
    expect(harness.events).toContainEqual([
      "context.window.snapshot",
      expect.objectContaining({
        compactionTriggerPercent: 90, compactionTriggerInputTokens: 28_800,
        availableInputTokens: 26_704, measuredInputTokens: 26_000,
      }),
    ]);
  });

  test.each([80_000, 89_999, 90_000])("early pinned projection shares the trigger at %i tokens", (tokens) => {
    const result = projectPinnedContext({
      fixedMessages: [], currentMessage: { role: "user", content: "now" },
      referenceParts: [],
      continuationParts: [{
        sourceRef: "role-result", category: "role_continuation", retention: "compactable",
        messages: [messageWithEstimatedTokens(tokens - 8)],
        compactMessages: [messageWithEstimatedTokens(100)],
      }],
      budget: budgetForStep(modelStep),
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.compaction.applied).toBe(tokens >= 90_000);
    expect(result.assessment.budget.compactionTriggerInputTokens).toBe(90_000);
  });
});

test.each(Object.values(MODEL_STEPS).filter((step) => !EA_STEPS.includes(step as typeof EA_STEPS[number])))(
  "%s retains the 70 percent budget policy without an override field", (modelStep) => {
    const budget = budgetForStep(modelStep);
    expect(Object.hasOwn(budget, "compactionTriggerRatio")).toBe(false);
    const assessment = assessRequestMessagesBudget({
      messages: [messageWithEstimatedTokens(70_000)], budget,
    });
    expect(assessment.budget.compactionTriggerInputTokens).toBe(70_000);
    expect(requiresContextCompaction(true, assessment)).toBe(true);
  },
);

test("legacy budgets without a policy field retain 70 percent", () => {
  const { compactionTriggerRatio: _ratio, ...legacyBudget } = budgetForStep("execution.decision");
  const assessment = assessRequestMessagesBudget({
    messages: [], budget: legacyBudget, measuredInputTokens: 70_000,
  });
  expect(assessment.budget.compactionTriggerInputTokens).toBe(70_000);
  expect(requiresContextCompaction(true, assessment)).toBe(true);
});

test.each(["context.compact", "execution.decision"] as const)(
  "%s preserves ineligible exact evidence without recursive compaction", async (modelStep) => {
    const harness = createAdmissionFixture({ modelStep, contextWindowTokens: 100_000, counts: [91_000] });
    const stage = createAdmissionStage("active_request", "unused");
    await expect(harness.invoker.invoke({
      modelStep, messages: [{ role: "user", content: "exact evidence" }],
      timeoutReason: "test_timeout",
      ...(modelStep === "execution.decision" ? { contextRetention: "exact" as const } : {}),
      contextCompaction: createAdmissionController([stage]), accept: (text) => text,
    })).resolves.toBe("ok");
    expect(stage.prepare).not.toHaveBeenCalled();
    expect(harness.events).toContainEqual([
      "context.window.snapshot",
      expect.objectContaining({ compactionTriggerEligible: false }),
    ]);
  },
);
