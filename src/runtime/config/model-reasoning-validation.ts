import type {
  ModelGatewayPolicyConfig,
  ModelGatewayProfileConfig,
  ModelGenerationConfig,
} from "../../model-gateway/types.js";
import { supportsModelReasoningBudget } from "../../shared/model-reasoning.js";

function validateBoundBudget(
  issues: string[],
  policy: ModelGatewayPolicyConfig,
  profile: ModelGatewayProfileConfig | undefined,
  budget: unknown,
  path: string,
): void {
  if (budget === undefined) return;
  if (!profile) return; // The model-reference owner diagnoses missing targets.
  const provider = policy.providers?.[profile.provider ?? ""];
  if (
    supportsModelReasoningBudget({
      provider: provider?.type ?? "",
      supportsThinking: profile.supportsThinking,
    })
  )
    return;
  issues.push(
    `${path} requires a llamacpp profile with supportsThinking: true`,
  );
}

function validateGenerationBudgets(
  issues: string[],
  policy: ModelGatewayPolicyConfig,
  profile: ModelGatewayProfileConfig | undefined,
  generation: ModelGenerationConfig | undefined,
  path: string,
): void {
  for (const key of ["reasoningBudget", "reasoningBudgetByMode"] as const) {
    validateBoundBudget(
      issues,
      policy,
      profile,
      generation?.[key],
      `${path}.${key}`,
    );
  }
}

/** Run after configRef materialization, before accepting any Runtime request. */
export function validateEffectiveReasoningBudgets(
  issues: string[],
  policy: ModelGatewayPolicyConfig | undefined,
): void {
  if (!policy) return;
  const profiles = policy.profiles ?? {};
  for (const [id, profile] of Object.entries(profiles)) {
    validateGenerationBudgets(
      issues,
      policy,
      profile,
      profile.generation,
      `models.profiles.${id}.generation`,
    );
    for (const [slot, calibration] of Object.entries(
      profile.calibration ?? {},
    )) {
      const target = calibration.profileId
        ? profiles[calibration.profileId]
        : profile;
      validateGenerationBudgets(
        issues,
        policy,
        target,
        calibration.generation,
        `models.profiles.${id}.calibration.${slot}.generation`,
      );
    }
  }
  for (const [id, invocation] of Object.entries(
    policy.invocationProfiles ?? {},
  )) {
    validateGenerationBudgets(
      issues,
      policy,
      profiles[invocation.profileId],
      invocation.generation,
      `models.invocationProfiles.${id}.generation`,
    );
  }
}
