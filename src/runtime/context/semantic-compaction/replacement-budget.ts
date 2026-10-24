import type { ModelStep } from "../../../shared/model-steps.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import type { SemanticCompactionSourceIdentity } from "./contracts.js";
import type { SemanticCompactionGenerationParams } from "./generation-contracts.js";

import {
  assertInheritedCompactionSourceDigests,
  resolvePriorCompactionSourceDigests,
} from "./inherited-source-digests.js";

const CHECKPOINT_CONTEXT_WINDOW_SHARE = 0.3;

/** A shared checkpoint must fit every declared consumer, starting with its caller. */
export function prepareReplacementCompactionBudget(
  params: SemanticCompactionGenerationParams,
  sources: readonly SemanticCompactionSourceIdentity[] = params.sources,
) {
  assertInheritedCompactionSourceDigests(params);
  const expectedSources = Object.freeze(
    [...resolvePriorCompactionSourceDigests(params), ...sources].map(
      ({ sourceRef, sourceFingerprint }) =>
        Object.freeze({ sourceRef, sourceFingerprint }),
    ),
  );
  const allowedConsumers = [...new Set(params.binding.allowedConsumers)];
  const consumer =
    params.consumer ??
    (allowedConsumers.length === 1 ? allowedConsumers[0] : undefined);
  if (consumer === undefined || !allowedConsumers.includes(consumer))
    throw new Error("context_compaction_budget_consumer_invalid");
  const admissions = [
    consumer,
    ...allowedConsumers.filter((step) => step !== consumer),
  ].map((step) => resolveConsumerBudget(params, step));
  const distinctAdmissions = new Map<string, (typeof admissions)[number]>();
  for (const entry of admissions) {
    const { invocation, budget } = entry.admission;
    // Calibration instructions affect provider input counting even for one profile.
    const measurementIdentity = JSON.stringify({
      profileId: invocation.profile.id,
      provider: invocation.profile.provider,
      model: invocation.model,
      contextWindowTokens: budget.contextWindowTokens,
      tokenEstimation: budget.tokenEstimation,
      instructions: invocation.instructions ?? [],
    });
    if (!distinctAdmissions.has(measurementIdentity))
      distinctAdmissions.set(measurementIdentity, entry);
  }
  const consumers = Object.freeze([...distinctAdmissions.values()]);
  return Object.freeze({
    expectedSources,
    checkpointTokenAllowance: Math.min(
      ...consumers.map((entry) => entry.checkpointTokenAllowance),
    ),
    consumer,
    admission: admissions[0]!.admission,
    consumers,
  });
}

function resolveConsumerBudget(
  params: SemanticCompactionGenerationParams,
  consumer: ModelStep,
) {
  const admission = resolveModelContextAdmission({
    runnerConfig: params.request.runnerConfig,
    agentMode: params.request.agentMode,
    modelStep: consumer,
    ...(params.request.modelPreference
      ? { modelPreference: params.request.modelPreference }
      : {}),
    ...(params.request.modelPolicy
      ? { modelPolicy: params.request.modelPolicy }
      : {}),
  });
  const checkpointTokenAllowance = Math.floor(
    admission.budget.contextWindowTokens * CHECKPOINT_CONTEXT_WINDOW_SHARE,
  );
  if (checkpointTokenAllowance < 1)
    throw new Error("context_compaction_token_allowance_invalid");
  return Object.freeze({ consumer, admission, checkpointTokenAllowance });
}
