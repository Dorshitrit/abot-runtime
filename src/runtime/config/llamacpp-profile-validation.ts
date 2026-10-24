import type {
  ModelGatewayPolicyConfig,
  ModelGatewayProfileConfig,
} from "../../model-gateway/types.js";

function requestsUnsupportedLlamaImageInput(
  profile: ModelGatewayProfileConfig,
  policy: ModelGatewayPolicyConfig,
): boolean {
  if (policy.providers?.[profile.provider ?? ""]?.type !== "llamacpp")
    return false;
  return profile.capabilities?.inputModalities?.includes("image") === true;
}

/** The current adapter is text-only even when the underlying server has a projector. */
export function validateLlamaCppProfileCapabilities(
  issues: string[],
  policy?: ModelGatewayPolicyConfig,
): void {
  if (!policy) return;
  for (const [id, profile] of Object.entries(policy.profiles ?? {})) {
    if (!requestsUnsupportedLlamaImageInput(profile, policy)) continue;
    issues.push(
      `models.profiles.${id}.capabilities.inputModalities: the llamacpp adapter supports text only`,
    );
  }
}
