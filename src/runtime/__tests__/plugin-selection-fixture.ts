import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig, RuntimePluginConfig } from "../ports.js";

const roots: string[] = [];

export async function removePluginSelectionFixtures(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}

export async function createPluginSelectionFixture(
  plugins: RuntimePluginConfig = { allow: ["*"] },
): Promise<RuntimeConfig> {
  const artifacts = join(
    process.cwd(),
    ".codex",
    "artifacts",
    "plugin-selection-tests",
  );
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "case-"));
  roots.push(rootDir);
  const pluginRoot = join(rootDir, "plugins", "fixture-active");
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "fixture-skill"), { recursive: true });
  await writeFile(
    join(pluginRoot, "skills", "fixture-skill", "SKILL.md"),
    "Fixture capability guidance.",
  );
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fixture-active",
      version: "1.0.0",
      extensions: {
        "ai.abot.runtime": {
          version: 1,
          entrypoint: "./src/index.cjs",
          capabilities: {
            fixture_ping: {
              description: "Observe an in-memory fixture value.",
              routingCapability: "semantic_lookup",
              skills: ["fixture-skill"],
              operations: {
                inspect_fixture: {
                  summary: "Observe fixture value.",
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
          },
        },
      },
    }),
  );
  await writeFile(
    join(pluginRoot, "src", "index.cjs"),
    `
let factoryCalls = 0;
module.exports = () => {
  factoryCalls += 1;
  return { handlers: {
    fixture_ping: async () => ({ ok: true, output: "fixture:" + factoryCalls, producedNewInformation: true })
  } };
};
`,
  );
  return {
    runtimeId: "plugin-selection-test",
    agentBridgeUrl: "ws://test",
    modelGatewayUrl: "http://test",
    plugins,
    requestRunner: { configPath: join(rootDir, "request-runner.json") },
    paths: {
      rootDir,
      runtimeDir: rootDir,
      agentWorkDir: rootDir,
      sessionsDir: rootDir,
      attachmentsDir: rootDir,
      workspaceDir: rootDir,
      sharedDir: rootDir,
      compiledDir: rootDir,
      traceFile: join(rootDir, "trace.jsonl"),
    },
  };
}
