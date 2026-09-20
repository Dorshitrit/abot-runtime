import { createHash } from "node:crypto";
import { isRecord } from "../../runtime/config/utils.js";

/** Stable private credential binding shared by additive provider setup. */
export function isolatedProviderCredentialName(providerId: string): string {
  const identity = createHash("sha256")
    .update(providerId)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `ABOT_MODEL_PROVIDER_${identity}_API_KEY`;
}

export function hasProviderCredentialBinding(
  providers: Record<string, unknown>,
  apiKeyEnv: string,
): boolean {
  return Object.values(providers).some((provider) => {
    if (!isRecord(provider)) return false;
    return provider.apiKeyEnv === apiKeyEnv;
  });
}
