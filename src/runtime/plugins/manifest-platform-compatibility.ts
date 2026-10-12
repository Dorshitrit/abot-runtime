import {
  ABOT_PLUGIN_COMPATIBILITY_EXTENSION,
  ABOT_PLUGIN_COMPATIBILITY_VERSION,
  PLUGIN_RUNTIME_PLATFORMS,
  type PluginPlatformDeclaration,
  type PluginRuntimePlatform,
} from "../../plugin-contract/platform-compatibility.js";
import { isRecord } from "../config/utils.js";

function hasUnknownCompatibilityField(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(
    (key) => key !== "version" && key !== "runtimePlatforms",
  );
}

function isRuntimePlatformList(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  return value.length <= PLUGIN_RUNTIME_PLATFORMS.length;
}

function isPluginRuntimePlatform(
  value: unknown,
): value is PluginRuntimePlatform {
  return PLUGIN_RUNTIME_PLATFORMS.some((platform) => platform === value);
}

function hasRepeatedRuntimePlatform(platforms: readonly unknown[]): boolean {
  return new Set(platforms).size !== platforms.length;
}

export function parsePluginPlatformDeclaration(
  value: unknown,
): PluginPlatformDeclaration | undefined {
  if (value === undefined) return undefined;
  const path = `extensions.${ABOT_PLUGIN_COMPATIBILITY_EXTENSION}`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (hasUnknownCompatibilityField(value))
    throw new Error(`${path} contains an unknown field`);
  if (value.version !== ABOT_PLUGIN_COMPATIBILITY_VERSION)
    throw new Error(
      `${path}.version must be ${ABOT_PLUGIN_COMPATIBILITY_VERSION}`,
    );
  if (!isRuntimePlatformList(value.runtimePlatforms))
    throw new Error(
      `${path}.runtimePlatforms must contain one to three platforms`,
    );
  if (!value.runtimePlatforms.every(isPluginRuntimePlatform))
    throw new Error(
      `${path}.runtimePlatforms must use linux, darwin, or win32`,
    );
  if (hasRepeatedRuntimePlatform(value.runtimePlatforms))
    throw new Error(`${path}.runtimePlatforms must not contain duplicates`);
  return Object.freeze({
    version: ABOT_PLUGIN_COMPATIBILITY_VERSION,
    runtimePlatforms: Object.freeze([...value.runtimePlatforms]),
  });
}
