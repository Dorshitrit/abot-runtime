import { describe, expect, test } from "vitest";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import { projectSuperCompactionConfiguration } from "../context/super-compaction/configuration.js";
import { resolvePolicySessionMemoryCompactor } from "../context/super-compaction/history-routing.js";
import { resolveModelStepTimeout } from "../model/model-step-timeout-policy.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/contracts.js";

function configuration() {
  const step = MODEL_STEPS.SUPER_COMPACTION_CONTENT;
  const runnerConfig: RequestRunnerConfig = {
    models: {
      defaults: {
        profileId: "local",
        steps: { "context.compact": "compactSlot", [step]: step },
      },
    },
    context: {
      outputReserveTokens: 100,
      safetyReserveTokens: 100,
      attachmentReserveTokens: 100,
    },
    steps: {
      "context.compact": { timeoutMs: 60_000 },
      [step]: { timeoutMs: 90_000 },
    },
  };
  const modelPolicy: ModelGatewayPolicyConfig = {
    profiles: {
      local: {
        model: "model",
        calibration: { compactSlot: { timeoutMs: 12_000 } },
      },
    },
    defaults: {
      profileId: "local",
      steps: { ...runnerConfig.models.defaults.steps },
    },
  };
  return { runnerConfig, modelPolicy };
}

describe("SUPER compaction configuration isolation", () => {
  test("inherits compaction calibration without mutating EA configuration", () => {
    const original = configuration();
    const snapshot = structuredClone(original);
    const adapted = projectSuperCompactionConfiguration(
      original,
      SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
    );
    for (const modelStep of [
      MODEL_STEPS.SUPER_COMPACTION_COVERAGE,
      MODEL_STEPS.SUPER_COMPACTION_CONTENT,
      MODEL_STEPS.SUPER_COMPACTION_MERGE,
      MODEL_STEPS.SUPER_COMPACTION_CONTINUATION,
    ]) {
      expect(adapted.modelPolicy?.defaults?.steps?.[modelStep]).toBe(
        "compactSlot",
      );
      expect(adapted.runnerConfig.steps[modelStep]?.timeoutMs).toBe(60_000);
      expect(
        resolveModelStepTimeout({
          modelStep,
          fallbackTimeoutMs: adapted.runnerConfig.steps[modelStep]!.timeoutMs,
          modelPolicy: adapted.modelPolicy,
        }).timeoutMs,
      ).toBe(12_000);
    }
    expect(original).toEqual(snapshot);
    expect(
      projectSuperCompactionConfiguration(
        original,
        EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      ),
    ).toBe(original);
  });

  test("retains explicit SUPER targets, calibration and shorter runner timeout", () => {
    const original = configuration();
    const content = MODEL_STEPS.SUPER_COMPACTION_CONTENT;
    const coverage = MODEL_STEPS.SUPER_COMPACTION_COVERAGE;
    original.modelPolicy.defaults!.steps![content] = "contentSlot";
    original.modelPolicy.profiles!.local!.calibration![coverage] = {
      timeoutMs: 4_000,
    };
    original.runnerConfig.steps[coverage] = { timeoutMs: 5_000 };
    const adapted = projectSuperCompactionConfiguration(
      original,
      SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
    );
    expect(adapted.modelPolicy?.defaults?.steps?.[content]).toBe("contentSlot");
    expect(adapted.runnerConfig.steps[coverage]?.timeoutMs).toBe(5_000);
    expect(
      adapted.modelPolicy?.profiles?.local?.calibration?.[coverage]?.timeoutMs,
    ).toBe(4_000);
  });

  test("selects history author by frozen authority and preserves explicit override", () => {
    const legacy = { compact: async () => "legacy" };
    const superCompactor = { compact: async () => "super" };
    expect(
      resolvePolicySessionMemoryCompactor(
        legacy,
        superCompactor,
        EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
      ),
    ).toBe(legacy);
    expect(
      resolvePolicySessionMemoryCompactor(
        legacy,
        superCompactor,
        SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      ),
    ).toBe(superCompactor);
    expect(
      resolvePolicySessionMemoryCompactor(
        legacy,
        legacy,
        SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      ),
    ).toBe(legacy);
  });
});
