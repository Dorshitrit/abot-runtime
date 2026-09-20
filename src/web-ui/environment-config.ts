import { inspectRuntimeConfigFileWithMeta } from "../runtime/config/loader.js";

const DEFAULT_ENVIRONMENT_ID = "prod";

export type WebUiEnvironmentOption = {
  id: string;
  label: string;
  isDefault: boolean;
};

export type WebUiEnvironmentConfig = {
  defaultEnvironmentId: string;
  environments: WebUiEnvironmentOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getConfigString(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const raw = value[key];
  return typeof raw === "string" ? raw.trim() : "";
}

export function resolveWebUiEnvironmentConfig(params: {
  rootDir: string;
  configPath?: string;
  defaultEnvironmentId?: string;
}): {
  defaultEnvironmentId: string;
  environments: WebUiEnvironmentOption[];
} {
  const overrideDefault = params.defaultEnvironmentId?.trim() ?? "";
  const fallbackDefault = overrideDefault || DEFAULT_ENVIRONMENT_ID;
  const fallback = {
    defaultEnvironmentId: fallbackDefault,
    environments: [
      {
        id: fallbackDefault,
        label: fallbackDefault,
        isDefault: true,
      },
    ],
  };

  let config: Record<string, unknown>;
  try {
    config = inspectRuntimeConfigFileWithMeta(
      params.rootDir,
      params.configPath,
    ).config;
  } catch {
    // Runtime configuration errors belong to the backend catalog response so
    // the Web UI can start and present the actionable setup error.
    return fallback;
  }
  const environment = isRecord(config.environment)
    ? config.environment
    : undefined;
  const profiles = isRecord(environment?.profiles)
    ? environment.profiles
    : undefined;
  const profileIds = profiles
    ? Object.keys(profiles).filter((id) => id.trim().length > 0)
    : [];
  const configuredDefault = getConfigString(environment, "default");
  const defaultEnvironmentId =
    overrideDefault ||
    configuredDefault ||
    profileIds[0] ||
    DEFAULT_ENVIRONMENT_ID;
  const environmentIds =
    profileIds.length > 0 ? [...profileIds] : [defaultEnvironmentId];
  if (!environmentIds.includes(defaultEnvironmentId)) {
    environmentIds.unshift(defaultEnvironmentId);
  }

  return {
    defaultEnvironmentId,
    environments: environmentIds.map((id) => ({
      id,
      label: id,
      isDefault: id === defaultEnvironmentId,
    })),
  };
}
