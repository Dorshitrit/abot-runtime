import type { AgentPluginManifest } from "../../plugin-contract/manifest.js";
import {
  ABOT_PLUGIN_COMPATIBILITY_EXTENSION,
  type PluginPlatformCompatibility,
  type PluginPlatformDeclaration,
} from "../../plugin-contract/platform-compatibility.js";

function runtimePlatformName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

function supportsDeclaredRuntimePlatform(
  declaration: PluginPlatformDeclaration,
  runtimePlatform: NodeJS.Platform,
): boolean {
  return declaration.runtimePlatforms.some(
    (platform) => platform === runtimePlatform,
  );
}

function undeclaredPlatformCompatibility(
  runtimePlatform: NodeJS.Platform,
): PluginPlatformCompatibility {
  if (runtimePlatform === "win32")
    return {
      supported: false,
      status: "undeclared",
      runtimePlatform,
      reason: "This plugin does not declare support for Windows Runtime.",
    };
  return { supported: true, status: "legacy", runtimePlatform };
}

/** Compatibility affects loading, never the user's saved plugin selection. */
export function resolvePluginPlatformCompatibility(
  manifest: AgentPluginManifest,
  runtimePlatform: NodeJS.Platform = process.platform,
): PluginPlatformCompatibility {
  const declaration = manifest.extensions[ABOT_PLUGIN_COMPATIBILITY_EXTENSION];
  if (!declaration) return undeclaredPlatformCompatibility(runtimePlatform);
  const runtimePlatforms = declaration.runtimePlatforms;
  if (supportsDeclaredRuntimePlatform(declaration, runtimePlatform))
    return {
      supported: true,
      status: "declared",
      runtimePlatform,
      runtimePlatforms,
    };
  return {
    supported: false,
    status: "unsupported",
    runtimePlatform,
    runtimePlatforms,
    reason: `This plugin supports Runtime on ${runtimePlatforms.map(runtimePlatformName).join(", ")}; this Runtime is running on ${runtimePlatformName(runtimePlatform)}.`,
  };
}
