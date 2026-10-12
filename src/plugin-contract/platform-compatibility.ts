export const ABOT_PLUGIN_COMPATIBILITY_EXTENSION = "ai.abot.compatibility";
export const ABOT_PLUGIN_COMPATIBILITY_VERSION = 1 as const;
export const PLUGIN_RUNTIME_PLATFORMS = ["linux", "darwin", "win32"] as const;

export type PluginRuntimePlatform = (typeof PLUGIN_RUNTIME_PLATFORMS)[number];

/** The OS running Runtime, independent of a connected computer's OS. */
export type PluginPlatformDeclaration = Readonly<{
  version: typeof ABOT_PLUGIN_COMPATIBILITY_VERSION;
  runtimePlatforms: readonly PluginRuntimePlatform[];
}>;

export type PluginPlatformCompatibility = Readonly<{
  supported: boolean;
  status: "declared" | "legacy" | "unsupported" | "undeclared";
  runtimePlatform: NodeJS.Platform;
  runtimePlatforms?: readonly PluginRuntimePlatform[];
  reason?: string;
}>;
