import type { AgentPluginManifest } from "../../plugin-contract/manifest.js";

export type DiscoveredAgentPluginManifest = Readonly<{
  pluginRoot: string;
  manifestPath: string;
  manifest: AgentPluginManifest;
}>;
