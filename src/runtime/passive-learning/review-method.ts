import type { RuntimeConfig } from "../ports.js";
import { resolveModelSelection } from "../model/model-selection.js";

/** Follow the selected profile's existing policy, never provider or model names. */
export function resolveCoWorkerReviewMethod(
  config: RuntimeConfig,
  profileId: string,
): "direct" | "staged" {
  const selection = resolveModelSelection({
    agentMode: "reasoning",
    modelPreference: { profileId, scope: "all" },
    modelPolicy: config.models,
    modelExecutionPolicies: config.modelExecutionPolicies,
  });
  return selection.execution.policy === "execution-agent-v1" ? "direct" : "staged";
}
