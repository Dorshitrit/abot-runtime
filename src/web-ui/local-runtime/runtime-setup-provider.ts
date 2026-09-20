import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildRuntimeModelConfiguration } from "../../runtime/config/builders.js";
import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import { parseRequestRunnerConfig } from "../../runtime/config/runner/versioned-config.js";
import { isRecord } from "../../runtime/config/utils.js";
import { readRuntimeSetupCredential } from "./runtime-setup-credentials.js";

function configuredSetupBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Setup inspects saved files without replacing the running owner's cached runner. */
export function readConfiguredSetupRunner(source: InspectedRuntimeConfigFile) {
  const ref = isRecord(source.config.requestRunner)
    ? source.config.requestRunner.configRef
    : undefined;
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  const path = resolve(dirname(source.path), ref.trim());
  return parseRequestRunnerConfig(JSON.parse(readFileSync(path, "utf8")), path);
}

export function configuredSetupModel(source: InspectedRuntimeConfigFile) {
  if (!source.exists) return undefined;
  const policy = buildRuntimeModelConfiguration(source.config, {
    mainConfigPath: source.path,
  }).modelPolicy;
  const defaultId =
    readConfiguredSetupRunner(source)?.models.defaults.profileId ??
    policy?.defaults?.profileId;
  const profile = defaultId
    ? policy?.profiles?.[defaultId]
    : Object.values(policy?.profiles ?? {})[0];
  if (!profile?.provider || !profile.model) return undefined;
  const provider = policy?.providers?.[profile.provider];
  if (!provider) return undefined;
  const apiKeyEnv = provider.apiKeyEnv?.trim() || "OPENAI_API_KEY";
  return {
    provider: provider.type,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    apiKeyEnv,
    baseUrl: configuredSetupBaseUrl(provider.baseUrl),
  };
}

export function requiresConfiguredCredential(
  source: InspectedRuntimeConfigFile,
  rootDir: string,
): boolean {
  const model = configuredSetupModel(source);
  if (model?.provider !== "openai") return false;
  return !readRuntimeSetupCredential(rootDir, model.apiKeyEnv);
}
