import { isRecord, type JsonObject } from "./runtime-setup-files.js";

export function parseRuntimeModelProfileId(value: string): string {
  const profile = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile)) {
    throw new Error(
      "--profile must start with a letter or number and use only letters, numbers, dot, underscore, or dash",
    );
  }
  return profile;
}

function readConfigMap(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${key} must be a JSON object`);
  return value;
}

/** Shared additive profile-declaration merge for CLI and Web model setup. */
export function mergeRuntimeModelAddition(
  runtimeConfig: JsonObject,
  input: {
    profileId: string;
    providerId: string;
    provider: JsonObject;
    profile: JsonObject;
    baseUrl?: string;
  },
): Readonly<{ config: JsonObject; providerAdded: boolean }> {
  const models = readConfigMap(runtimeConfig, "models");
  const providers = readConfigMap(models, "providers");
  const profiles = readConfigMap(models, "profiles");
  if (profiles[input.profileId] !== undefined) {
    throw new Error(
      `model profile already exists: ${input.profileId}; no files were changed`,
    );
  }
  const existingProvider = providers[input.providerId];
  if (existingProvider !== undefined) {
    if (
      !isRecord(existingProvider) ||
      existingProvider.type !== input.provider.type
    ) {
      throw new Error(
        `provider id is already configured with a different adapter: ${input.providerId}; no files were changed`,
      );
    }
    if (
      input.provider.type === "ollama" &&
      input.baseUrl &&
      existingProvider.baseUrl !== input.baseUrl
    ) {
      throw new Error(
        `provider ${input.providerId} already uses a different base URL; no files were changed`,
      );
    }
  }
  return {
    providerAdded: existingProvider === undefined,
    config: {
      ...runtimeConfig,
      models: {
        ...models,
        providers: {
          ...providers,
          ...(existingProvider === undefined
            ? { [input.providerId]: input.provider }
            : {}),
        },
        profiles: { ...profiles, [input.profileId]: input.profile },
      },
    },
  };
}
