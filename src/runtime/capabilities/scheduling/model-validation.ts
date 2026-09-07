import { resolveModelSelection } from "../../model/model-selection.js";
import type { RuntimeConfig } from "../../ports.js";

export function requireAvailableScheduleModel(
  config: RuntimeConfig,
  modelProfileId: unknown,
): void {
  if (typeof modelProfileId !== "string") {
    throw new Error("scheduler_model_required");
  }
  const selection = resolveModelSelection({
    agentMode: "reasoning",
    modelPreference: { profileId: modelProfileId },
    modelPolicy: config.models,
  });
  const isSelectedScheduleModel =
    selection.execution.primaryProfileId === modelProfileId;
  if (!isSelectedScheduleModel) {
    throw new Error("scheduler_model_unavailable");
  }
}
