import { readNestedConfigStringArray } from "./utils.js";
import {
  validateOptionalObject,
  validateOptionalStringArray,
} from "./validation/runtime-config-field-validation.js";

/** Runtime-only restrictions for the canonical request model profile. */
export type RuntimeModelPluginConfig = Readonly<{
  deny?: readonly string[];
}>;

export function captureModelPluginConfig(
  config: RuntimeModelPluginConfig | undefined,
): RuntimeModelPluginConfig | undefined {
  const deny = readNestedConfigStringArray(config, "deny");
  if (!deny) return undefined;
  return Object.freeze({ deny: Object.freeze(deny.sort()) });
}

export function buildModelPluginConfig(
  value: unknown,
): RuntimeModelPluginConfig | undefined {
  const deny = readNestedConfigStringArray(value, "deny");
  return captureModelPluginConfig(deny ? { deny } : undefined);
}

function isSupportedModelPluginField(key: string): boolean {
  return key === "deny";
}

export function validateModelPluginConfig(
  issues: string[],
  profile: Record<string, unknown>,
  displayKey: string,
): void {
  const plugins = validateOptionalObject(
    issues,
    profile,
    "plugins",
    `${displayKey}.plugins`,
  );
  if (!plugins) return;
  for (const key of Object.keys(plugins)) {
    if (isSupportedModelPluginField(key)) continue;
    issues.push(
      `${displayKey}.plugins.${key} is not a supported configuration field`,
    );
  }
  validateOptionalStringArray(
    issues,
    plugins,
    "deny",
    `${displayKey}.plugins.deny`,
  );
}

export function modelPluginConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Runtime-only restrictions applied to the entire request selected by this model profile. Global plugin restrictions still apply.",
    properties: {
      deny: {
        type: "array",
        items: { type: "string" },
        description:
          "Denied plugin IDs, capability names, plugin.capability selectors, or *. These restrictions do not depend on per-step model overrides.",
      },
    },
    additionalProperties: false,
  };
}
