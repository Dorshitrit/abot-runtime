import type { RequestModelSelectionPresentation } from "../../shared/session-model-selection.js";
import type { RequestExecutionSeed } from "./contracts.js";
import type { CompiledRequestExecutionPolicy } from "./execution-scope.js";

type ModelSelectionSeed = Pick<RequestExecutionSeed,
  "executionPolicySelection" | "modelPolicy" | "agentMode" | "reasoningPreference">;

/** Project the captured request selection, including restored approval seeds. */
export function projectRequestModelSelection(
  seed: ModelSelectionSeed,
  rootContract: Pick<CompiledRequestExecutionPolicy["rootContract"], "decisionModelStep" | "responseModelStep">,
  selectedAt: number,
): RequestModelSelectionPresentation {
  const primaryProfileId = seed.executionPolicySelection?.primaryProfileId;
  const profile = primaryProfileId ? seed.modelPolicy?.profiles?.[primaryProfileId] : undefined;
  const provider = profile?.provider ? seed.modelPolicy?.providers?.[profile.provider]?.type : undefined;
  return {
    selectedAt,
    ...(primaryProfileId ? { primaryProfileId } : {}),
    agentMode: seed.agentMode,
    ...(seed.reasoningPreference ? { reasoningPreference: structuredClone(seed.reasoningPreference) } : {}),
    rootModelSteps: [...new Set([rootContract.decisionModelStep, rootContract.responseModelStep])],
    ...(profile && provider ? { primaryModel: {
      label: profile.label?.trim() || primaryProfileId!, provider, model: profile.model,
    } } : {}),
  };
}
