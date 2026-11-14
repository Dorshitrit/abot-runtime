import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import { resolveModelSelection } from "../model/model-selection.js";
import { captureRequestReasoningPreference } from "../request/reasoning-preference.js";
import type { CreateSchedulerJobInput } from "../scheduler/contracts.js";

/** Validate explicit controls with the same profile binding as request admission. */
export function validateScheduledReasoningPreference(
  input: Readonly<CreateSchedulerJobInput>,
  modelPolicy: ModelGatewayPolicyConfig | undefined,
): void {
  if (!input.reasoningPreference) return;
  const selection = resolveModelSelection({
    agentMode: input.agentMode,
    modelPreference: { profileId: input.modelProfileId, scope: "all" },
    modelPolicy,
  });
  captureRequestReasoningPreference(input.reasoningPreference, selection);
}
