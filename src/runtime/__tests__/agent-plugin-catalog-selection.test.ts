import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createDefaultSkillProvider,
  createDefaultToolRegistry,
} from "../default-adapters.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import type { RuntimeConfig } from "../ports.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Agent plugin compiled catalog selection", () => {
  test("does not require an entrypoint for an excluded manifest package", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "blocked-plugin",
      capabilities: {
        blocked_lookup: { skillName: "blocked-skill" },
      },
      entrypointSource: `throw new Error("excluded entrypoint executed");`,
    });
    config.plugins = {
      allow: ["blocked-plugin"],
      deny: ["blocked-plugin"],
    };

    expect(loadConfiguredRuntimePlugins(config)).toEqual([]);
  });

  test("keeps skills only for selected manifest capabilities", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "dual-plugin",
      capabilities: {
        selected_lookup: { skillName: "selected-skill" },
        excluded_lookup: {
          skillName: "excluded-skill",
          skillContent: "",
        },
      },
      entrypointSource: `module.exports = {
        handlers: {
          selected_lookup: async () => ({ ok: true, output: "selected", producedNewInformation: true }),
          excluded_lookup: async () => ({ ok: true, output: "excluded", producedNewInformation: true })
        }
      };`,
    });
    config.plugins = { allow: ["dual-plugin.selected_lookup"] };

    const registry = createDefaultToolRegistry(config);
    expect(registry.listDefinitions().map(({ name }) => name)).toEqual([
      "selected_lookup",
    ]);
    const skillProvider = createDefaultSkillProvider(config, {
      toolRegistry: registry,
    });
    await expect(
      skillProvider.getActionContext("selected_lookup"),
    ).resolves.toContain("selected-skill guidance");
    await expect(
      skillProvider.getActionContext("excluded_lookup"),
    ).resolves.toBe("");
  });

  test("shares one compiled factory instance between registry and skills", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "cached-plugin",
      capabilities: {
        cached_lookup: { skillName: "cached-skill" },
      },
      entrypointSource: `let factoryCalls = 0;
        module.exports = () => {
          factoryCalls += 1;
          if (factoryCalls > 1) {
            throw new Error("plugin factory executed more than once");
          }
          return {
            handlers: {
              cached_lookup: async () => ({ ok: true, output: "instance:" + factoryCalls, producedNewInformation: true })
            }
          };
        };`,
    });
    config.plugins = { allow: ["cached-plugin"] };

    const firstCatalog = loadConfiguredRuntimePlugins(config);
    const secondCatalog = loadConfiguredRuntimePlugins(config);
    expect(secondCatalog).toBe(firstCatalog);
    expect(Object.isFrozen(firstCatalog)).toBe(true);

    const registry = createDefaultToolRegistry(config);
    const skillProvider = createDefaultSkillProvider(config, {
      toolRegistry: registry,
    });
    await expect(
      skillProvider.getActionContext("cached_lookup"),
    ).resolves.toContain("cached-skill guidance");
    await expect(
      registry.execute({ tool: "cached_lookup", params: {} }),
    ).resolves.toMatchObject({ output: "instance:1" });
  });

  test("merges bundled plugins with consumer-root plugins", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "consumer-probe",
      capabilities: {
        consumer_probe: { skillName: "consumer-probe-skill" },
      },
      entrypointSource: `module.exports = {
        handlers: {
          consumer_probe: async () => ({ ok: true, output: "consumer", producedNewInformation: true })
        }
      };`,
    });
    config.plugins = { allow: ["system-probe", "consumer-probe"] };

    const plugins = loadConfiguredRuntimePlugins(config);

    expect(plugins.map(({ id }) => id)).toEqual([
      "system-probe",
      "consumer-probe",
    ]);
    expect(
      plugins.flatMap(({ capabilities }) =>
        capabilities.map(({ definition }) => definition.name),
      ),
    ).toEqual(["system_probe", "consumer_probe"]);
  });

  test("discovers a physical package root only once through an alias", async () => {
    const aliasParent = join(
      tmpdir(),
      `agent-plugin-root-alias-${randomUUID()}`,
    );
    roots.push(aliasParent);
    await mkdir(aliasParent, { recursive: true });
    const aliasRoot = join(aliasParent, "runtime");
    await symlink(process.cwd(), aliasRoot, "dir");
    const config = runtimeConfigForRoot(aliasRoot);
    config.plugins = { allow: ["system-probe"] };

    expect(loadConfiguredRuntimePlugins(config).map(({ id }) => id)).toEqual([
      "system-probe",
    ]);
  });

  test("rejects a consumer plugin that duplicates a bundled plugin id", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "system-probe",
      capabilities: {
        consumer_duplicate_probe: { skillName: "duplicate-probe-skill" },
      },
      entrypointSource: `module.exports = {
        handlers: {
          consumer_duplicate_probe: async () => ({ ok: true, output: "duplicate", producedNewInformation: true })
        }
      };`,
    });
    config.plugins = { allow: ["consumer_duplicate_probe"] };

    expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
      "Duplicate runtime plugin id: system-probe",
    );
  });
});

async function createRuntimeConfig(): Promise<{
  rootDir: string;
  config: RuntimeConfig;
}> {
  const rootDir = join(tmpdir(), `agent-plugin-catalog-${randomUUID()}`);
  roots.push(rootDir);
  await mkdir(join(rootDir, "plugins"), { recursive: true });
  return {
    rootDir,
    config: runtimeConfigForRoot(rootDir),
  };
}

function runtimeConfigForRoot(rootDir: string): RuntimeConfig {
  return {
    runtimeId: "agent-plugin-catalog-test",
    agentBridgeUrl: "ws://test",
    modelGatewayUrl: "http://model",
    requestRunner: {
      configPath: join(rootDir, "request-runner.config.json"),
    },
    paths: {
      rootDir,
      runtimeDir: join(rootDir, ".runtime"),
      agentWorkDir: join(rootDir, "agent-work"),
      sessionsDir: join(rootDir, "sessions"),
      attachmentsDir: join(rootDir, "attachments"),
      workspaceDir: join(rootDir, "workspace"),
      sharedDir: join(rootDir, "shared"),
      compiledDir: join(rootDir, "compiled"),
      traceFile: join(rootDir, "trace.jsonl"),
    },
  };
}

async function writeManifestPlugin(
  rootDir: string,
  params: {
    pluginName: string;
    capabilities: Record<string, { skillName: string; skillContent?: string }>;
    entrypointSource: string;
  },
): Promise<void> {
  const pluginRoot = join(rootDir, "plugins", params.pluginName);
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  for (const { skillName, skillContent } of Object.values(
    params.capabilities,
  )) {
    const skillRoot = join(pluginRoot, "skills", skillName);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      skillContent ??
        `---\nname: ${skillName}\ndescription: ${skillName} guidance.\n---\n\n# ${skillName}\n`,
      "utf-8",
    );
  }
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: params.pluginName,
        version: "1.0.0",
        extensions: {
          "ai.abot.runtime": {
            version: 1,
            entrypoint: "./src/index.cjs",
            capabilities: Object.fromEntries(
              Object.entries(params.capabilities).map(
                ([capabilityId, { skillName }]) => [
                  capabilityId,
                  {
                    description: `${capabilityId} description`,
                    routingCapability: "semantic_lookup",
                    skills: [skillName],
                    operations: {
                      [`run_${capabilityId}`]: {
                        summary: `Run ${capabilityId}`,
                        input: {
                          type: "object",
                          additionalProperties: false,
                          properties: {},
                          required: [],
                        },
                        effect: "read_only",
                        approval: "request_policy",
                      },
                    },
                  },
                ],
              ),
            ),
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  await writeFile(
    join(pluginRoot, "src", "index.cjs"),
    params.entrypointSource,
    "utf-8",
  );
}
