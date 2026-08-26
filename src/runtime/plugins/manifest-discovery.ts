import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { traceDebug } from "../observability/debug-logger.js";
import type { DiscoveredAgentPluginManifest } from "./discovered-manifest.js";
import { parseAgentPluginManifest } from "./manifest-validator.js";

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function resolveContainedPluginFile(params: {
  pluginRoot: string;
  configuredPath: string;
  label: string;
}): string {
  if (!params.configuredPath.startsWith("./")) {
    throw new Error(`${params.label} must start with ./`);
  }
  const candidate = resolve(params.pluginRoot, params.configuredPath);
  if (!existsSync(candidate)) {
    throw new Error(`${params.label} does not exist: ${params.configuredPath}`);
  }
  const resolvedRoot = realpathSync(params.pluginRoot);
  const resolvedCandidate = realpathSync(candidate);
  if (!isContained(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${params.label} resolves outside the plugin root`);
  }
  if (!statSync(resolvedCandidate).isFile()) {
    throw new Error(`${params.label} must resolve to a regular file`);
  }
  return resolvedCandidate;
}

export function readAgentPluginSkills(
  plugin: DiscoveredAgentPluginManifest,
  selectedSkillNames?: ReadonlySet<string>,
): Record<string, string> {
  const skillsRoot = join(plugin.pluginRoot, "skills");
  if (!existsSync(skillsRoot)) {
    return {};
  }
  const resolvedPluginRoot = realpathSync(plugin.pluginRoot);
  const resolvedSkillsRoot = realpathSync(skillsRoot);
  if (
    !isContained(resolvedPluginRoot, resolvedSkillsRoot) ||
    !statSync(resolvedSkillsRoot).isDirectory()
  ) {
    throw new Error(
      `Runtime plugin ${plugin.manifest.name} skills must be a contained directory`,
    );
  }

  const skills: Record<string, string> = {};
  const entries = readdirSync(resolvedSkillsRoot, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (selectedSkillNames && !selectedSkillNames.has(entry.name)) {
      continue;
    }
    const skillPath = join(resolvedSkillsRoot, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) {
      continue;
    }
    const resolvedSkillPath = realpathSync(skillPath);
    if (
      !isContained(resolvedPluginRoot, resolvedSkillPath) ||
      !statSync(resolvedSkillPath).isFile()
    ) {
      throw new Error(
        `Runtime plugin ${plugin.manifest.name} skill ${entry.name} resolves outside the plugin root`,
      );
    }
    const content = readFileSync(resolvedSkillPath, "utf-8");
    if (!content.trim()) {
      throw new Error(
        `Runtime plugin ${plugin.manifest.name} skill ${entry.name} is empty`,
      );
    }
    skills[entry.name] = content;
  }
  return skills;
}

export function discoverAgentPluginManifests(
  rootDir: string,
): DiscoveredAgentPluginManifest[] {
  const pluginsPath = resolve(rootDir, "plugins");
  traceDebug("runtime.plugins", "manifest_discovery.started", {
    pluginsPath,
  });
  if (!existsSync(pluginsPath)) {
    traceDebug("runtime.plugins", "manifest_discovery.completed", {
      pluginsPath,
      pluginCount: 0,
    });
    return [];
  }

  const resolvedPluginsPath = realpathSync(pluginsPath);
  const entries = readdirSync(resolvedPluginsPath, {
    withFileTypes: true,
  }).sort((left, right) => left.name.localeCompare(right.name));
  const discovered: DiscoveredAgentPluginManifest[] = [];

  for (const entry of entries) {
    const candidateRoot = join(resolvedPluginsPath, entry.name);
    if (!statSync(candidateRoot).isDirectory()) {
      continue;
    }
    const pluginRoot = realpathSync(candidateRoot);
    if (!isContained(resolvedPluginsPath, pluginRoot)) {
      throw new Error(
        `Runtime plugin folder ${entry.name} resolves outside rootDir/plugins`,
      );
    }
    const manifestPath = join(pluginRoot, "plugin.json");
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
      traceDebug("runtime.plugins", "manifest_discovery.folder_skipped", {
        pluginFolder: entry.name,
        reason: "plugin_json_missing",
      });
      continue;
    }

    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
      const manifest = parseAgentPluginManifest(raw, entry.name);
      discovered.push({ pluginRoot, manifestPath, manifest });
      traceDebug("runtime.plugins", "manifest_discovery.plugin_loaded", {
        pluginId: manifest.name,
        manifestPath,
        capabilityCount: Object.keys(
          manifest.extensions["ai.abot.runtime"].capabilities,
        ).length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceDebug("runtime.plugins", "manifest_discovery.plugin_rejected", {
        pluginFolder: entry.name,
        manifestPath,
        issue: message,
      });
      throw new Error(
        `Failed to load runtime plugin manifest ${manifestPath}: ${message}`,
      );
    }
  }

  traceDebug("runtime.plugins", "manifest_discovery.completed", {
    pluginsPath,
    pluginCount: discovered.length,
    pluginIds: discovered.map(({ manifest }) => manifest.name),
  });
  return discovered;
}
