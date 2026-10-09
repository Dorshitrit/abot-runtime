import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getRuntimeConfig,
  patchRuntimeConfig,
  validateRuntimeConfigCandidate,
} from "../admin/config-control.js";
import { getRuntimeStatus } from "../admin/system-control.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";

const artifactRoot = resolve(".codex/artifacts/onboarding-context-path-fixes");
let fixtureDir = "";
let rootDir = "";

beforeEach(async () => {
  await mkdir(artifactRoot, { recursive: true });
  fixtureDir = await mkdtemp(join(artifactRoot, "admin-config-path-"));
  rootDir = join(fixtureDir, "working root ספריה");
  await mkdir(rootDir);
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function writeConfigFixture(configPath: string): Promise<string> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    join(dirname(configPath), "request-runner.config.json"),
    JSON.stringify({
      models: {
        defaults: {
          profileId: "default",
          steps: Object.fromEntries(
            REQUEST_INVOKED_STEP_IDS.map((id) => [id, "default"]),
          ),
        },
      },
      context: {
        outputReserveTokens: 4096,
        safetyReserveTokens: 1200,
        attachmentReserveTokens: 1024,
      },
      steps: Object.fromEntries(
        REQUEST_INVOKED_STEP_IDS.map((id) => [id, { timeoutMs: 90000 }]),
      ),
    }),
  );
  const original = JSON.stringify({
    models: {
      providers: { local: { type: "ollama" } },
      profiles: {
        default: {
          provider: "local",
          model: "config-path-fixture",
          contextWindowTokens: 32768,
        },
      },
    },
    requestRunner: { configRef: "./request-runner.config.json" },
    logging: { enabled: true },
  });
  await writeFile(configPath, original);
  return original;
}

describe("runtime admin config path identity", () => {
  test.each([
    { name: "default", selectedPath: () => undefined, target: "runtime.config.json" },
    {
      name: "relative",
      selectedPath: () => "local/runtime.config.json",
      target: "local/runtime.config.json",
    },
    {
      name: "relative with parent segments",
      selectedPath: () => "local/../settings/runtime.config.json",
      target: "settings/runtime.config.json",
    },
    {
      name: "absolute inside the root",
      selectedPath: () => join(rootDir, "local/runtime.config.json"),
      target: "local/runtime.config.json",
    },
    {
      name: "absolute outside the root",
      selectedPath: () => join(fixtureDir, "external settings ספריה/runtime.config.json"),
      target: "../external settings ספריה/runtime.config.json",
    },
  ])("reads and patches the same $name file", async ({ selectedPath, target }) => {
    const configPath = resolve(rootDir, target);
    const original = await writeConfigFixture(configPath);
    const options = { rootDir, configPath: selectedPath() };
    const metadata = { rootDir, configPath, exists: true };

    const current = getRuntimeConfig({ ...options, env: {} });
    expect(current.metadata).toEqual(metadata);
    expect(current.fileConfig.logging).toMatchObject({ enabled: true });
    expect(current.effectiveConfig.models?.profiles?.default?.model).toBe(
      "config-path-fixture",
    );
    expect(getRuntimeStatus({ ...options, env: {} }).config).toMatchObject({
      rootDir,
      configPath,
      configExists: true,
    });
    expect(
      validateRuntimeConfigCandidate({
        ...options,
        patch: { logging: { enabled: false } },
      }),
    ).toMatchObject({ ok: true });
    expect(await readFile(configPath, "utf8")).toBe(original);

    const result = await patchRuntimeConfig({
      ...options,
      patch: { logging: { enabled: false } },
    });
    expect(result).toMatchObject({ ok: true, metadata, restartRequired: true });
    expect(result.backupPath).toBeDefined();
    expect(dirname(result.backupPath!)).toBe(dirname(configPath));
    expect(await readFile(result.backupPath!, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      logging: { enabled: false },
    });
    expect((await readdir(dirname(configPath))).sort()).toEqual(
      [
        basename(configPath),
        basename(result.backupPath!),
        "request-runner.config.json",
      ].sort(),
    );
    expect(getRuntimeConfig({ ...options, env: {} }).metadata).toEqual(metadata);
  });
});
