import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadRuntimeConfig, RUNTIME_CONFIG_JSON_SCHEMA } from "../config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function loadProfile(
  profile: Record<string, unknown>,
  options: { referenced?: boolean; inline?: Record<string, unknown> } = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-model-plugin-config-"));
  roots.push(rootDir);
  const materialized = {
    provider: "local",
    model: "model:test",
    contextWindowTokens: 32_768,
    ...profile,
  };
  await writeFile(join(rootDir, "model.json"), JSON.stringify(materialized));
  await writeFile(
    join(rootDir, "runner.json"),
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "selected", steps: {} } },
      context: {
        outputReserveTokens: 4096,
        safetyReserveTokens: 1200,
        attachmentReserveTokens: 1024,
      },
      stepDefaults: { timeoutMs: 90_000 },
      steps: {},
    }),
  );
  await writeFile(
    join(rootDir, "runtime.config.json"),
    JSON.stringify({
      requestRunner: { configRef: "./runner.json" },
      plugins: { deny: ["globally-denied"] },
      models: {
        providers: { local: { type: "ollama" } },
        profiles: {
          selected: options.referenced
            ? { configRef: "./model.json", ...options.inline }
            : materialized,
        },
      },
    }),
  );
  return loadRuntimeConfig({ rootDir, env: {} });
}

describe("model profile plugin configuration", () => {
  test.each([false, true])(
    "loads runtime-only deny selectors with configRef=%s",
    async (referenced) => {
      const config = await loadProfile(
        {
          plugins: { deny: ["memory", " filesystem.read_file ", "memory", ""] },
          execution: { policy: "execution-agent-v1" },
        },
        { referenced },
      );
      expect(config.modelExecutionPolicies).toEqual({
        selected: {
          policy: "execution-agent-v1",
          plugins: { deny: ["filesystem.read_file", "memory"] },
        },
      });
      expect(config.models?.profiles?.selected).not.toHaveProperty("plugins");
      expect(config.models?.profiles?.selected).not.toHaveProperty("execution");
      expect(config.plugins?.deny).toEqual(["globally-denied"]);
    },
  );

  test("captures deny without opting into a different execution policy", async () => {
    const config = await loadProfile({ plugins: { deny: ["memory"] } });
    expect(config.modelExecutionPolicies).toEqual({
      selected: { plugins: { deny: ["memory"] } },
    });
  });

  test.each([undefined, {}, { deny: [] }])(
    "does not add runtime policy for unrestricted plugins %j",
    async (plugins) => {
      const config = await loadProfile(
        plugins === undefined ? {} : { plugins },
      );
      expect(config.modelExecutionPolicies).toBeUndefined();
    },
  );

  test.each([{ deny: ["exec"] }, { deny: [] }])(
    "retains inline configRef replacement semantics for %j",
    async ({ deny }) => {
      const config = await loadProfile(
        { plugins: { deny: ["memory"] } },
        {
          referenced: true,
          inline: { plugins: { deny } },
        },
      );
      expect(
        config.modelExecutionPolicies?.selected?.plugins?.deny ?? [],
      ).toEqual(deny);
    },
  );

  test.each([
    { plugins: "memory", error: "plugins must be an object" },
    {
      plugins: { deny: "memory" },
      error: "plugins.deny must be an array of strings",
    },
    { plugins: { deny: [1] }, error: "plugins.deny must contain only strings" },
    {
      plugins: { allow: ["*"] },
      error: "plugins.allow is not a supported configuration field",
    },
    {
      plugins: { enabled: false },
      error: "plugins.enabled is not a supported configuration field",
    },
  ])(
    "rejects unsupported referenced profile plugins: $error",
    async ({ plugins, error }) => {
      await expect(
        loadProfile({ plugins }, { referenced: true }),
      ).rejects.toThrow(error);
    },
  );

  test("advertises deny only in the profile schema", () => {
    expect(RUNTIME_CONFIG_JSON_SCHEMA).toHaveProperty(
      "properties.models.properties.profiles.additionalProperties.properties.plugins",
      {
        type: "object",
        description: expect.any(String),
        additionalProperties: false,
        properties: {
          deny: {
            type: "array",
            items: { type: "string" },
            description: expect.any(String),
          },
        },
      },
    );
  });
});
