import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { configureDebugLogger } from "../observability/debug-logger.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { discoverAgentPluginManifests } from "../plugins/manifest-discovery.js";
import { loadConfiguredRuntimePlugins } from "../plugins/loader.js";
import { projectManifestRuntimeContract } from "../plugins/manifest-projection.js";
import type { RuntimeConfig } from "../ports.js";

const roots: string[] = [];

beforeEach(() => configureDebugLogger({ enabled: false }));

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Agent Plugins manifest loader", () => {
  test("loads the documented manifest example through the production contract", async () => {
    const docs = readFileSync(
      join(process.cwd(), "docs", "plugins.md"),
      "utf8",
    );
    const manifestBlock = docs.match(
      /## Manifest Contract[\s\S]*?```json\n([\s\S]*?)\n```/u,
    )?.[1];
    expect(manifestBlock).toBeDefined();
    const manifest = JSON.parse(manifestBlock!) as { name: string };
    const { config, rootDir } = await createRuntimeConfig();
    const pluginRoot = join(rootDir, "plugins", manifest.name);
    await mkdir(join(pluginRoot, "src"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "example_lookup_skill"), {
      recursive: true,
    });
    await writeFile(
      join(pluginRoot, "plugin.json"),
      `${manifestBlock}\n`,
      "utf8",
    );
    await writeFile(
      join(pluginRoot, "src", "index.cjs"),
      `module.exports = {
        handlers: {
          example_lookup: async ({ query }) => ({
            ok: true,
            output: String(query),
            producedNewInformation: true
          })
        }
      };`,
      "utf8",
    );
    await writeFile(
      join(pluginRoot, "skills", "example_lookup_skill", "SKILL.md"),
      "# Example lookup\n\nUse the bounded example lookup.\n",
      "utf8",
    );
    config.plugins = { allow: [manifest.name] };

    const [loaded] = loadConfiguredRuntimePlugins(config);
    expect(loaded?.capabilities[0]?.normalInvocation.operations).toMatchObject([
      {
        operationId: "lookup",
        input: {
          properties: {
            query: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
      },
    ]);
    expect(loaded?.capabilities[0]?.definition.catalogGroups).toEqual(["read"]);
    expect(loaded?.capabilitySkills).toEqual({
      example_lookup: ["example_lookup_skill"],
    });
  });

  test("discovers sorted consumer manifest packages", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "beta-plugin",
      capabilityId: "beta_lookup",
      operationId: "lookup_beta",
    });
    await writeManifestPlugin(rootDir, {
      pluginName: "alpha-plugin",
      capabilityId: "alpha_lookup",
      operationId: "lookup_alpha",
      skillName: "alpha-lookup",
    });
    config.plugins = { allow: ["alpha-plugin", "beta-plugin"] };
    const plugins = loadConfiguredRuntimePlugins(config);

    expect(plugins.map(({ id }) => id)).toEqual([
      "alpha-plugin",
      "beta-plugin",
    ]);
    const alpha = plugins[0];
    expect(alpha.skills).toEqual({
      "alpha-lookup": expect.stringContaining("Alpha lookup guidance"),
    });
    expect(alpha.capabilitySkills).toEqual({
      alpha_lookup: ["alpha-lookup"],
    });
    expect(alpha.capabilities[0]).toMatchObject({
      definition: {
        name: "alpha_lookup",
        description: "alpha-plugin capability",
        catalogGroups: ["alpha-plugin"],
      },
      normalInvocation: {
        version: 1,
        operations: [
          {
            operationId: "lookup_alpha",
            effect: "read_only",
            approval: "request_policy",
          },
        ],
      },
    });
    await expect(
      alpha.capabilities[0]?.execute({ query: "runtime" }),
    ).resolves.toMatchObject({
      output: "alpha-plugin:runtime",
      producedNewInformation: true,
    });
  });

  test("normalizes legacy operation skills into canonical capability ownership", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "legacy-skills-plugin",
      capabilityId: "legacy_lookup",
      operationId: "lookup",
      skillName: "legacy-lookup-skill",
    });
    const manifestPath = join(
      rootDir,
      "plugins",
      "legacy-skills-plugin",
      "plugin.json",
    );
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as any;
    const capability =
      raw.extensions[ABOT_RUNTIME_EXTENSION].capabilities.legacy_lookup;
    delete capability.skills;
    capability.operations.lookup.skills = ["legacy-lookup-skill"];
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    config.plugins = { allow: ["legacy-skills-plugin"] };

    const [discovered] = discoverAgentPluginManifests(rootDir);
    const normalized =
      discovered!.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities
        .legacy_lookup!;
    expect(normalized.skills).toEqual(["legacy-lookup-skill"]);
    expect(normalized.operations.lookup).not.toHaveProperty("skills");
    expect(loadConfiguredRuntimePlugins(config)[0]?.capabilitySkills).toEqual({
      legacy_lookup: ["legacy-lookup-skill"],
    });
  });

  test("accepts matching legacy and canonical skill unions but rejects conflicts", async () => {
    const { rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "matching-skills-plugin",
      capabilityId: "matching_lookup",
      operationId: "lookup",
      skillName: "matching-lookup-skill",
    });
    const manifestPath = join(
      rootDir,
      "plugins",
      "matching-skills-plugin",
      "plugin.json",
    );
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as any;
    const operation =
      raw.extensions[ABOT_RUNTIME_EXTENSION].capabilities.matching_lookup
        .operations.lookup;
    operation.skills = ["matching-lookup-skill"];
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    expect(() => discoverAgentPluginManifests(rootDir)).not.toThrow();

    operation.skills = ["different-skill"];
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    expect(() => discoverAgentPluginManifests(rootDir)).toThrow(
      "skills conflicts with legacy operation skills",
    );
  });

  test("projects skill-free mechanical controls refinement into the tool definition", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "mechanical-controls-plugin",
      capabilityId: "mechanical_lookup",
      operationId: "lookup",
      controlsRefinement: "mechanical_when_complete",
    });
    config.plugins = { allow: ["mechanical-controls-plugin"] };

    const [loaded] = loadConfiguredRuntimePlugins(config);
    expect(loaded?.capabilities[0]?.definition).toMatchObject({
      name: "mechanical_lookup",
      controlsRefinement: "mechanical_when_complete",
    });
  });

  test("rejects mechanical controls refinement when the capability owns skills", async () => {
    const { rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "skilled-mechanical-controls-plugin",
      capabilityId: "skilled_mechanical_lookup",
      operationId: "lookup",
      skillName: "lookup-guidance",
      controlsRefinement: "mechanical_when_complete",
    });

    expect(() => discoverAgentPluginManifests(rootDir)).toThrow(
      "controlsRefinement requires empty skills",
    );
  });

  test("rejects staged model outputs as manifest decision selection controls", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    const pluginName = "staged-selection-control-plugin";
    const capabilityId = "staged_selection_control";
    const operationId = "apply_staged_selection";
    await writeManifestPlugin(rootDir, {
      pluginName,
      capabilityId,
      operationId,
    });
    const manifestPath = join(rootDir, "plugins", pluginName, "plugin.json");
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as any;
    const capability =
      raw.extensions[ABOT_RUNTIME_EXTENSION].capabilities[capabilityId];
    capability.routingCapability = "filesystem_mutation";
    capability.payloadChannelSpec = {
      params: ["selection", "content"],
      outputParam: "content",
      generationMode: "raw_text",
      stages: [
        {
          outputParam: "selection",
          promptHint: "Choose the bounded edit selection.",
        },
        {
          outputParam: "content",
          promptHint: "Return the complete replacement content.",
        },
      ],
    };
    const operation = capability.operations[operationId];
    operation.input.properties.selection = {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
    };
    operation.input.required.push("selection");
    operation.selectionControlIds = ["selection"];
    operation.effect = "mutating";
    operation.payload = {
      kind: "raw_text",
      param: "content",
      instructions: "Return the complete replacement content.",
      maxBytes: 4_096,
    };
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    config.plugins = { allow: [pluginName] };

    expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
      "selection control selection must remain in the effective public input",
    );
  });

  test("rejects an entrypoint that escapes its plugin root", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "escape-plugin",
      capabilityId: "escape_lookup",
      operationId: "escape_lookup",
      entrypoint: "./../outside.cjs",
    });
    await writeFile(
      join(rootDir, "plugins", "outside.cjs"),
      "module.exports = { handlers: {} };",
      "utf-8",
    );
    config.plugins = { allow: ["escape-plugin"] };

    expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
      "entrypoint resolves outside the plugin root",
    );
  });

  test("projects the complete manifest contract into one runtime plugin", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    const requiredSecretEnv = `AGENT_PLUGIN_TEST_SECRET_${randomUUID()
      .replaceAll("-", "")
      .toUpperCase()}`;
    process.env[requiredSecretEnv] = "declared-secret";

    try {
      await writeFullContractManifestPlugin(rootDir, {
        requiredSecretEnv,
        entrypointSource: `module.exports = (context) => ({
          handlers: {
            rich_capability: async (input) => ({
              ok: true,
              output: [
                context.config.prefix,
                context.config.maxItems,
                context.secrets.get("apiToken"),
                context.secrets.get("optionalToken") ?? "optional-missing",
                input.query
              ].join(":"),
              producedNewInformation: true
            })
          },
          adapters: {
            rich_capability: {
              normalizeCall: (input) => ({
                tool: input.tool,
                params: { ...input.params, normalized: true }
              }),
              validateCall: () => null
            }
          }
        });`,
      });
      config.plugins = { allow: ["full-contract-plugin"] };

      const [plugin] = loadConfiguredRuntimePlugins(config);
      const [tool] = plugin?.capabilities ?? [];

      expect(plugin).toMatchObject({
        id: "full-contract-plugin",
        skills: {
          "capability-skill": expect.stringContaining("Capability guidance"),
        },
        capabilitySkills: {
          rich_capability: ["capability-skill"],
        },
      });
      expect(tool?.definition).toMatchObject({
        name: "rich_capability",
        routingCapability: "filesystem_mutation",
        catalogGroups: ["write"],
        developmentRoles: ["establish", "mutate", "verify"],
        eventPresentation: {
          metadata: {
            path: { param: "target", kind: "string", default: "." },
            queryLength: { param: "query", kind: "length", default: 0 },
          },
        },
        payloadChannelSpec: {
          params: ["content"],
          outputParam: "content",
          generationMode: "raw_text",
          targetParam: "target",
          contextScope: "target_only",
          targetContext: "full_numbered",
          groundingWindow: 2,
          requiresCurrentTargetObservation: {
            targetParam: "target",
            contentRequirement: "full",
          },
        },
      });
      expect(tool?.normalInvocation).toEqual({
        version: 1,
        operations: [
          {
            operationId: "run_rich_capability",
            summary: "Run the rich capability",
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                query: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                },
                target: {
                  type: "string",
                  minLength: 1,
                  maxLength: 4096,
                },
                start_line: {
                  type: "integer",
                  minimum: 1,
                  maximum: 1000000,
                },
                end_line: {
                  type: "integer",
                  minimum: 1,
                  maximum: 1000000,
                },
              },
              required: ["query", "target", "start_line", "end_line"],
            },
            effect: "mutating",
            approval: "request_policy",
            fixedParams: {
              mode: "strict",
              maxAttempts: 2,
              enabled: true,
            },
            payload: {
              kind: "raw_text",
              param: "content",
              instructions: "Return only the replacement text.",
              minBytes: 1,
              maxBytes: 4096,
            },
          },
        ],
      });
      expect(
        tool?.adapter?.normalizeCall?.({
          tool: "rich_capability",
          params: { query: "runtime" },
        }),
      ).toEqual({
        tool: "rich_capability",
        params: { query: "runtime", normalized: true },
      });
      await expect(tool?.execute({ query: "runtime" })).resolves.toMatchObject({
        output: "configured:3:declared-secret:optional-missing:runtime",
        producedNewInformation: true,
      });
    } finally {
      delete process.env[requiredSecretEnv];
    }
  });

  test("rejects a manifest plugin when a required declared secret is missing", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    const requiredSecretEnv = `AGENT_PLUGIN_MISSING_SECRET_${randomUUID()
      .replaceAll("-", "")
      .toUpperCase()}`;
    delete process.env[requiredSecretEnv];
    await writeFullContractManifestPlugin(rootDir, {
      requiredSecretEnv,
      entrypointSource: `module.exports = {
        handlers: {
          rich_capability: async () => ({ ok: true, output: "unused", producedNewInformation: true })
        }
      };`,
    });
    config.plugins = { allow: ["full-contract-plugin"] };

    const [discovered] = discoverAgentPluginManifests(rootDir);
    expect(() =>
      projectManifestRuntimeContract(
        discovered!,
        Object.keys(
          discovered!.manifest.extensions[ABOT_RUNTIME_EXTENSION].capabilities,
        ),
      ),
    ).not.toThrow();

    expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
      `requires secret apiToken from environment variable ${requiredSecretEnv}`,
    );
  });

  test("rejects an entrypoint factory that requests an undeclared secret", async () => {
    const { config, rootDir } = await createRuntimeConfig();
    const requiredSecretEnv = `AGENT_PLUGIN_DECLARED_SECRET_${randomUUID()
      .replaceAll("-", "")
      .toUpperCase()}`;
    process.env[requiredSecretEnv] = "declared-secret";

    try {
      await writeFullContractManifestPlugin(rootDir, {
        requiredSecretEnv,
        entrypointSource: `module.exports = (context) => {
          context.secrets.get("notDeclared");
          return {
            handlers: {
              rich_capability: async () => ({ ok: true, output: "unused", producedNewInformation: true })
            }
          };
        };`,
      });
      config.plugins = { allow: ["full-contract-plugin"] };

      expect(() => loadConfiguredRuntimePlugins(config)).toThrow(
        "requested undeclared secret notDeclared",
      );
    } finally {
      delete process.env[requiredSecretEnv];
    }
  });

  test("rejects invalid plugin catalog groups", async () => {
    const { rootDir } = await createRuntimeConfig();
    await writeManifestPlugin(rootDir, {
      pluginName: "context-plugin",
      capabilityId: "context_lookup",
      operationId: "lookup",
    });
    const manifestPath = join(
      rootDir,
      "plugins",
      "context-plugin",
      "plugin.json",
    );
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as any;
    const extension = raw.extensions[ABOT_RUNTIME_EXTENSION];
    extension.catalogGroups = ["Invalid Group"];
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    expect(() => discoverAgentPluginManifests(rootDir)).toThrow(
      "catalogGroups.0 is not a valid catalog group id",
    );

    extension.catalogGroups = [];
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    expect(() => discoverAgentPluginManifests(rootDir)).toThrow(
      "catalogGroups must be a non-empty array",
    );

    extension.catalogGroups = ["read"];
    extension.capabilities.context_lookup.catalogGroups = ["read", "read"];
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    expect(() => discoverAgentPluginManifests(rootDir)).toThrow(
      "catalogGroups must not contain duplicates",
    );
  });

  test.each([
    {
      name: "schema version",
      folderName: "valid-plugin",
      manifestName: "valid-plugin",
      schema: "https://agent-plugins.org/schemas/0.9.0/plugin.schema.json",
      issue: "plugin.json.$schema must be",
    },
    {
      name: "folder identity",
      folderName: "folder-plugin",
      manifestName: "different-plugin",
      schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      issue: "must match plugin.json name",
    },
  ])(
    "rejects an invalid $name",
    async ({ folderName, manifestName, schema, issue }) => {
      const { rootDir } = await createRuntimeConfig();
      await writeManifestPlugin(rootDir, {
        pluginName: folderName,
        manifestName,
        capabilityId: "lookup",
        operationId: "lookup",
        schema,
      });

      expect(() => discoverAgentPluginManifests(rootDir)).toThrow(issue);
    },
  );
});

async function createRuntimeConfig(): Promise<{
  rootDir: string;
  config: RuntimeConfig;
}> {
  const rootDir = join(tmpdir(), `agent-plugin-loader-${randomUUID()}`);
  roots.push(rootDir);
  await mkdir(join(rootDir, "plugins"), { recursive: true });
  return {
    rootDir,
    config: {
      runtimeId: "agent-plugin-loader-test",
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
    },
  };
}

async function writeManifestPlugin(
  rootDir: string,
  params: {
    pluginName: string;
    manifestName?: string;
    capabilityId: string;
    operationId: string;
    skillName?: string;
    entrypoint?: string;
    schema?: string;
    controlsRefinement?: "mechanical_when_complete";
  },
): Promise<void> {
  const pluginRoot = join(rootDir, "plugins", params.pluginName);
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  if (params.skillName) {
    await mkdir(join(pluginRoot, "skills", params.skillName), {
      recursive: true,
    });
    await writeFile(
      join(pluginRoot, "skills", params.skillName, "SKILL.md"),
      `---\nname: ${params.skillName}\ndescription: Test guidance.\n---\n\n# Alpha lookup guidance\n`,
      "utf-8",
    );
  }
  const entrypoint = params.entrypoint ?? "./src/index.cjs";
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        $schema:
          params.schema ??
          "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: params.manifestName ?? params.pluginName,
        version: "1.0.0",
        extensions: {
          "ai.abot.runtime": {
            version: 1,
            entrypoint,
            capabilities: {
              [params.capabilityId]: {
                description: `${params.pluginName} capability`,
                routingCapability: "semantic_lookup",
                skills: params.skillName ? [params.skillName] : [],
                ...(params.controlsRefinement
                  ? { controlsRefinement: params.controlsRefinement }
                  : {}),
                operations: {
                  [params.operationId]: {
                    summary: `${params.pluginName} lookup`,
                    input: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        query: {
                          type: "string",
                          minLength: 1,
                          maxLength: 128,
                        },
                      },
                      required: ["query"],
                    },
                    effect: "read_only",
                    approval: "request_policy",
                  },
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  const entrypointPath = join(pluginRoot, entrypoint);
  await mkdir(join(entrypointPath, ".."), { recursive: true });
  await writeFile(
    entrypointPath,
    `module.exports = {
      handlers: {
        ${JSON.stringify(params.capabilityId)}: async (input) => ({
          ok: true,
          output: ${JSON.stringify(params.pluginName + ":")} + input.query,
          producedNewInformation: true
        })
      }
    };`,
    "utf-8",
  );
}

async function writeFullContractManifestPlugin(
  rootDir: string,
  params: {
    requiredSecretEnv: string;
    entrypointSource: string;
  },
): Promise<void> {
  const pluginName = "full-contract-plugin";
  const pluginRoot = join(rootDir, "plugins", pluginName);
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  const skillRoot = join(pluginRoot, "skills", "capability-skill");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    "---\nname: capability-skill\ndescription: Test capability-skill.\n---\n\n# Capability guidance\n",
    "utf-8",
  );
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: pluginName,
        version: "1.0.0",
        extensions: {
          "ai.abot.runtime": {
            version: 1,
            entrypoint: "./src/index.cjs",
            catalogGroups: ["read"],
            settings: {
              defaults: {
                prefix: "configured",
                maxItems: 3,
              },
            },
            secrets: {
              apiToken: {
                env: params.requiredSecretEnv,
                required: true,
              },
              optionalToken: {
                env: `AGENT_PLUGIN_OPTIONAL_SECRET_${randomUUID()
                  .replaceAll("-", "")
                  .toUpperCase()}`,
                required: false,
              },
            },
            capabilities: {
              rich_capability: {
                description: "Full contract capability",
                routingCapability: "filesystem_mutation",
                catalogGroups: ["write"],
                skills: ["capability-skill"],
                developmentRoles: ["establish", "mutate", "verify"],
                eventPresentation: {
                  metadata: {
                    path: {
                      param: "target",
                      kind: "string",
                      default: ".",
                    },
                    queryLength: {
                      param: "query",
                      kind: "length",
                      default: 0,
                    },
                  },
                },
                payloadChannelSpec: {
                  params: ["content"],
                  outputParam: "content",
                  generationMode: "raw_text",
                  targetParam: "target",
                  contextScope: "target_only",
                  targetContext: "full_numbered",
                  groundingWindow: 2,
                  requiresCurrentTargetObservation: {
                    targetParam: "target",
                    contentRequirement: "full",
                  },
                },
                operations: {
                  run_rich_capability: {
                    summary: "Run the rich capability",
                    input: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        query: {
                          type: "string",
                          minLength: 1,
                          maxLength: 128,
                        },
                        target: {
                          type: "string",
                          minLength: 1,
                          maxLength: 4096,
                        },
                        start_line: {
                          type: "integer",
                          minimum: 1,
                          maximum: 1000000,
                        },
                        end_line: {
                          type: "integer",
                          minimum: 1,
                          maximum: 1000000,
                        },
                      },
                      required: ["query", "target", "start_line", "end_line"],
                    },
                    effect: "mutating",
                    approval: "request_policy",
                    fixedParams: {
                      mode: "strict",
                      maxAttempts: 2,
                      enabled: true,
                    },
                    payload: {
                      kind: "raw_text",
                      param: "content",
                      instructions: "Return only the replacement text.",
                      minBytes: 1,
                      maxBytes: 4096,
                    },
                  },
                },
              },
            },
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
