import { describe, expect, it, vi } from "vitest";
import type { ToolAvailabilityEntry, ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { parseToolDefinition } from "../../capabilities/tool-definition-validator.js";
import { buildToolAvailabilityBrief } from "../../plugin-sdk/tool-availability-brief.js";
import { buildToolAvailabilityOverview } from "../../plugin-sdk/tool-availability-overview.js";
import { resolveRegisteredToolCapabilityCatalog } from "../adapters/registered-tool-worker-capabilities/catalog.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { projectAvailableTools } from "../capabilities/tool-availability.js";
import { projectCapabilityBriefAtHeadroom } from "../context/capability-brief.js";
import { projectCapabilityCatalogGroups } from "../orchestration/capability-adapters/index.js";
import { discoverAgentPluginManifests } from "../plugins/manifest-discovery.js";
import { projectManifestRuntimeContract } from "../plugins/manifest-projection.js";

function pluginModules(name: string, capabilityIds: string[], omitDescription = false) {
  const discovered = discoverAgentPluginManifests(process.cwd())
    .find(({ manifest }) => manifest.name === name)!;
  const { description, ...legacyManifest } = discovered.manifest;
  const projection = projectManifestRuntimeContract({
    ...discovered,
    manifest: omitDescription ? legacyManifest : discovered.manifest,
  }, capabilityIds);
  const execute = vi.fn(async () => { throw new Error("unexpected_plugin_execution"); });
  const modules: ToolModuleDeclaration[] = projection.capabilities.map((capability) => ({
    ...capability,
    implementation: execute,
  }));
  const registry = createConfiguredToolRegistry(undefined, modules);
  return { description, modules, registry, execute,
    entries: projectAvailableTools(registry.listNormalInvocations?.())!,
  };
}

describe("plugin discovery metadata", () => {
  it("preserves optional real manifest descriptions through repeated registry validation", () => {
    const current = pluginModules("system", ["system_targets", "system_command"]);
    const legacy = pluginModules("system", ["system_targets", "system_command"], true);
    expect(current.description).toEqual(expect.any(String));
    for (const entry of current.entries) {
      expect(entry).toMatchObject({ pluginName: "system", pluginDescription: current.description });
      expect(Object.isFrozen(entry)).toBe(true);
    }
    for (const entry of legacy.entries) {
      expect(entry.pluginName).toBe("system");
      expect(entry).not.toHaveProperty("pluginDescription");
    }
    expect(current.entries.map(({ pluginDescription: _description, ...entry }) => entry))
      .toEqual(legacy.entries);
    expect(resolveRegisteredToolCapabilityCatalog(current.registry, true).descriptors)
      .toEqual(resolveRegisteredToolCapabilityCatalog(legacy.registry, true).descriptors);
    expect(current.execute).not.toHaveBeenCalled();
    expect(legacy.execute).not.toHaveBeenCalled();
  });

  it("retains distinct plugins sharing a group and one plugin spanning multiple groups", () => {
    const filesystem = pluginModules("filesystem", ["read_file", "write_file"]);
    const outline = pluginModules("code-outline", ["inspect_code_outline"]);
    const registry = createConfiguredToolRegistry(undefined, [...filesystem.modules, ...outline.modules]);
    const entries = projectAvailableTools(registry.listNormalInvocations?.())!;
    const readers = entries.filter(({ catalogGroups }) => catalogGroups.includes("read"));
    expect(new Set(readers.map(({ pluginName }) => pluginName)))
      .toEqual(new Set(["filesystem", "code-outline"]));
    expect(new Set(entries.filter(({ pluginName }) => pluginName === "filesystem")
      .flatMap(({ catalogGroups }) => catalogGroups))).toEqual(new Set(["read", "write"]));
    for (const entry of entries) {
      const expected = entry.pluginName === "filesystem" ? filesystem.description : outline.description;
      expect(entry.pluginDescription).toBe(expected);
    }
    const descriptors = resolveRegisteredToolCapabilityCatalog(registry, true).descriptors;
    const compact = projectCapabilityBriefAtHeadroom({
      entries, groups: projectCapabilityCatalogGroups(descriptors), headroom: 100_000,
    });
    expect(compact.message?.content.split("\n").slice(-2).join("\n")).toBe(
      `Tool groups: read: code-outline [inspect_code_outline], filesystem [read_file] | write: filesystem [write_file]\nPlugin descriptions: code-outline: ${outline.description} | filesystem: ${filesystem.description}`,
    );
  });

  it("uses plugin discovery for delegation while preserving SDK model projections", () => {
    const { registry, entries } = pluginModules("system", ["system_targets", "system_command"]);
    const legacy: ToolAvailabilityEntry[] = entries.map(({ pluginName: _name, pluginDescription: _description, ...entry }) => entry);
    const descriptors = resolveRegisteredToolCapabilityCatalog(registry, true).descriptors;
    const groups = projectCapabilityCatalogGroups(descriptors);
    const compact = projectCapabilityBriefAtHeadroom({ entries, groups, headroom: 100_000 });
    expect(compact.message?.content).toContain("system: system [system_command, system_targets]");
    const bare = projectCapabilityBriefAtHeadroom({ entries: legacy, groups, headroom: 100_000 });
    expect(bare.message?.content.split("\n").at(-1)).toBe("Tool groups: system: system_command, system_targets");
    for (const entry of entries) {
      expect(compact.message?.content).not.toContain(entry.operationId);
      expect(bare.message?.content).not.toContain(entry.operationId);
    }
    for (const level of ["detailed", "titles", "groups"] as const) {
      expect(buildToolAvailabilityOverview(entries, groups, level))
        .toBe(buildToolAvailabilityOverview(legacy, groups, level));
    }
    expect(buildToolAvailabilityBrief(entries)).toEqual(buildToolAvailabilityBrief(legacy));
  });

  it("validates plugin descriptions without requiring metadata for standalone tools", () => {
    const definition = { name: "plain", routingCapability: "semantic_lookup", params: {} };
    expect(parseToolDefinition(definition)).not.toHaveProperty("pluginDescription");
    expect(parseToolDefinition({ ...definition, pluginDescription: "" }).pluginDescription).toBe("");
    expect(() => parseToolDefinition({ ...definition, pluginDescription: 42 }))
      .toThrow("Invalid tool definition for plain (pluginDescription)");
  });
});
