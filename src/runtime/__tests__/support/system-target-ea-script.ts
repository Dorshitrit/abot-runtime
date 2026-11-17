import { expect } from "vitest";
import type { ModelGatewayClient, ToolPermissionMode } from "../../ports.js";
import { finalDispatchReport, targetHandoffSeed } from "./system-target-handoff-fixture.js";
import { readHandoffCapsule, type HandoffModelInput, type HandoffScriptCall } from "./system-target-handoff-script.js";

const decision = (value: unknown) => JSON.stringify({ decision: value });
const controls = (value: unknown) => decision({ invocations: { invocation_1: { disposition: "execute", controls: value } } });

export function targetEaSeed(invoke: ModelGatewayClient["invoke"], mode: ToolPermissionMode) {
  const seed = targetHandoffSeed(invoke, mode);
  return {
    ...seed,
    executionPolicySelection: { policy: "execution-agent-v1" as const, primaryProfileId: "test", source: "model_profile" as const },
    runnerConfig: { ...seed.runnerConfig, steps: {
      ...seed.runnerConfig.steps,
      "execution.decision": { timeoutMs: 20_000 },
      "execution.response": { timeoutMs: 20_000 },
    } },
  };
}

export function createTargetEaScript(assertApplicationEvidence: (input: HandoffModelInput) => void = () => {}): HandoffScriptCall[] {
  return [
    { step: "execution.decision", output: decision({ action: "open_capability_scope", catalogGroupIds: ["system"] }) },
    { step: "execution.decision", output: decision({
      action: "invoke_capability", capabilityId: "discover_system_applications", workingDirectory: ".",
      selectionControls: { target: "windows", query: "Fixture", limit: 50 },
    }) },
    { step: "execution.decision", output: (input) => {
      assertApplicationEvidence(input);
      expect(JSON.stringify(input.messages)).toContain("Fixture.App");
      return decision({ action: "invoke_capability", capabilityId: "launch_system_application",
        operationObjective: "Dispatch launch for the observed identity on the same Windows host.",
        controlsEvidenceExecutionIds: ["capability-execution-1"] });
    } },
    { step: "capability.controls", output: (input) => {
      expect(readHandoffCapsule(input, "runtime_request_tool_results_v1")).toMatchObject({
        results: [expect.objectContaining({ executionId: "capability-execution-1", outcome: "succeeded" })],
      });
      return controls({ target: "windows", application_id: "Fixture.App", arguments: [] });
    } },
    { step: "execution.decision", output: (input) => {
      const result = readHandoffCapsule(input, "runtime_execution_capability_result_v1");
      expect(result).toMatchObject({ result: { outcome: "succeeded", adapterResult: { result: { data: {
        evidenceScope: "launch_request_dispatch", independentOutcomeCheck: "not_performed",
      } } } } });
      return decision({ action: "respond" });
    } },
    { step: "execution.response", output: finalDispatchReport },
  ];
}
