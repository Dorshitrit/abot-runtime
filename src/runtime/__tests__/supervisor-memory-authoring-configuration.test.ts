import { expect, test, vi } from "vitest";
import type { ModelStepCalibrationConfig } from "../../model-gateway/types.js";
import { projectConfiguredStepMessages } from "../config/runner/step-instructions.js";
import {
  buildSupervisorMemoryConfiguredGuidance,
  hasCompatibleSupervisorMemoryConfiguration,
} from "../steps/supervisor-decision/memory-authoring-configuration.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

function request(response: ModelStepCalibrationConfig = {}) {
  const base = createInvalidOutputRequest(vi.fn());
  return deriveTestRequestExecutionScope(base, {
    modelPolicy: {
      ...base.modelPolicy,
      profiles: {
        test: { provider: "local", model: "test", contextWindowTokens: 64_000,
          calibration: { decision: {}, response } },
        other: { provider: "local", model: "other", contextWindowTokens: 64_000 },
      },
      defaults: { profileId: "test", steps: {
        "supervisor.decision": "decision", "supervisor.response": "response",
      } },
    },
  });
}

test("equivalent invocation settings qualify without creating empty configured guidance", () => {
  const input = request({ format: "json" });
  expect(hasCompatibleSupervisorMemoryConfiguration(input)).toBe(true);
  expect(buildSupervisorMemoryConfiguredGuidance(input)).toBeUndefined();
});

test.each<ModelStepCalibrationConfig>([
  { profileId: "other" },
  { generation: { temperature: 0.9 } },
  { generation: { reasoningBudget: { mode: "tokens", tokens: 256 } } },
  { instructions: ["Different calibrated memory guidance."] },
  { timeoutMs: 30_000 },
  { profileId: "missing-profile" },
])("changed or unresolved memory invocation keeps the separate path: %j", response => {
  expect(hasCompatibleSupervisorMemoryConfiguration(request(response))).toBe(false);
});

test("different runner guidance qualifies while exact response guidance stays scoped", () => {
  const base = request();
  const responseContent = "Preserve durable preferences.\nPresentation remains presentation only.";
  const input = deriveTestRequestExecutionScope(base, {
    runnerConfig: { ...base.runnerConfig, steps: {
      ...base.runnerConfig.steps,
      "supervisor.decision": { timeoutMs: 20_000, instructionBlocks: [
        { ref: "routing", contentHash: "routing", content: "ROUTING_ONLY" },
      ] },
      "supervisor.response": { timeoutMs: 20_000, instructionBlocks: [
        { ref: "response", contentHash: "response", content: responseContent },
      ] },
    } },
  });
  const original = structuredClone(input.runnerConfig);
  const appendix = projectConfiguredStepMessages({ runnerConfig: input.runnerConfig,
    modelStep: "supervisor.response", messages: [{ role: "system", content: "" }],
  }).messages[0]!.content;
  const guidance = buildSupervisorMemoryConfiguredGuidance(input)!;
  expect(hasCompatibleSupervisorMemoryConfiguration(input)).toBe(true);
  expect(guidance).toContain(appendix);
  expect(guidance.split(responseContent)).toHaveLength(2);
  expect(guidance).toContain("applies only to memoryCandidates");
  expect(guidance).toContain("no routing, execution, permission or completion authority");
  expect(guidance).not.toContain("ROUTING_ONLY");
  expect(input.runnerConfig).toEqual(original);
});
