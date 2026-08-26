import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../config.js";

const rootDir = resolve(import.meta.dirname, "../../..");
const initScript = join(rootDir, "scripts", "init-runtime.ts");
const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
const temporaryRoots: string[] = [];

async function createTargetRoot(): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), "abot-init-"));
  temporaryRoots.push(targetRoot);
  return targetRoot;
}

function runInit(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, initScript, ...args], {
    cwd: rootDir,
    encoding: "utf-8",
  });
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("init-runtime", () => {
  it("requires an explicit provider and model", () => {
    const missingProvider = runInit(["--model", "vendor/model"]);
    expect(missingProvider.status).toBe(1);
    expect(missingProvider.stderr).toContain("--provider is required");

    const missingModel = runInit(["--provider", "ollama"]);
    expect(missingModel.status).toBe(1);
    expect(missingModel.stderr).toContain("--model is required");
  });

  it.each([
    [
      "ollama",
      "vendor/local-model",
      {
        ollama: {
          type: "ollama",
          baseUrl: "http://127.0.0.1:11434",
        },
      },
      "none",
    ],
    [
      "openai",
      "vendor/hosted-model",
      {
        openai: {
          type: "openai",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
      "estimate",
    ],
    [
      "future-adapter",
      "vendor/future-model",
      {
        "future-adapter": {
          type: "future-adapter",
        },
      },
      "estimate",
    ],
  ] as const)(
    "creates a generic default profile for %s",
    async (provider, model, expectedProviders, expectedAccountingMode) => {
      const targetRoot = await createTargetRoot();
      const result = runInit([
        "--provider",
        provider,
        "--model",
        model,
        "--root",
        targetRoot,
      ]);

      expect(result.status, result.stderr).toBe(0);
      const runtimeConfig = await readJson(
        join(targetRoot, "local", "runtime.config.json"),
      );
      const runnerConfig = await readJson(
        join(targetRoot, "local", "request-runner.config.json"),
      );
      const modelConfig = await readJson(
        join(targetRoot, "local", "models", "default.config.json"),
      );
      const runtimeModels = asRecord(runtimeConfig.models);
      const runnerDefaults = asRecord(asRecord(runnerConfig.models).defaults);

      expect(runtimeModels.providers).toEqual(expectedProviders);
      expect(runtimeModels.profiles).toEqual({
        default: { configRef: "./models/default.config.json" },
      });
      expect(runtimeModels.defaults).toBeUndefined();
      expect(runnerDefaults.profileId).toBe("default");
      expect(modelConfig).toMatchObject({ label: model, provider, model });
      if (provider === "openai") {
        expect(modelConfig.execution).toEqual({
          policy: "execution-agent-v1",
        });
      } else {
        expect(modelConfig.execution).toBeUndefined();
      }
      expect(
        asRecord(asRecord(modelConfig.context).formatTokenAccounting),
      ).toEqual({ mode: expectedAccountingMode });
      expect(Object.keys(asRecord(modelConfig.calibration))).toEqual(
        expect.arrayContaining([
          "supervisor.decision",
          "worker.decision",
          "planner.decision",
          "execution.decision",
          "context.compact",
          "toolPayload.raw",
        ]),
      );
      const loaded = loadRuntimeConfig({
        rootDir: targetRoot,
        env: { LLM_RUNTIME_CONFIG_FILE: "local/runtime.config.json" },
      });
      expect(loaded.models?.profiles?.default).toMatchObject({
        provider,
        model,
        context: {
          formatTokenAccounting: { mode: expectedAccountingMode },
        },
      });
      expect(loaded.modelExecutionPolicies?.default).toEqual(
        provider === "openai" ? { policy: "execution-agent-v1" } : undefined,
      );
      expect(
        JSON.stringify([runtimeConfig, runnerConfig, modelConfig]),
      ).not.toMatch(/gemma|gpt-5/i);
    },
  );

  it("configures an explicit Ollama origin for a separate provider host", async () => {
    const targetRoot = await createTargetRoot();
    const result = runInit([
      "--provider",
      "ollama",
      "--model",
      "gemma4:e4b",
      "--base-url",
      "http://host.docker.internal:11434/",
      "--root",
      targetRoot,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const runtimeConfig = await readJson(
      join(targetRoot, "local", "runtime.config.json"),
    );
    expect(asRecord(asRecord(runtimeConfig.models).providers)).toEqual({
      ollama: {
        type: "ollama",
        baseUrl: "http://host.docker.internal:11434",
      },
    });
    expect(result.stdout).toContain(
      "base URL: http://host.docker.internal:11434",
    );
  });

  it("rejects unsafe or unsupported provider base URLs", () => {
    const invalidOrigin = runInit([
      "--provider",
      "ollama",
      "--model",
      "local-model",
      "--base-url",
      "http://localhost:11434/api/tags",
    ]);
    expect(invalidOrigin.status).toBe(1);
    expect(invalidOrigin.stderr).toContain(
      "--base-url must be a valid HTTP or HTTPS origin",
    );

    const unsupportedProvider = runInit([
      "--provider",
      "openai",
      "--model",
      "hosted-model",
      "--base-url",
      "https://api.example.com",
    ]);
    expect(unsupportedProvider.status).toBe(1);
    expect(unsupportedProvider.stderr).toContain(
      "--base-url is supported only with --provider ollama",
    );
  });

  it("keeps existing local config unless force is explicit", async () => {
    const targetRoot = await createTargetRoot();
    const first = runInit([
      "--provider",
      "ollama",
      "--model",
      "first-model",
      "--root",
      targetRoot,
    ]);
    expect(first.status, first.stderr).toBe(0);

    const second = runInit([
      "--provider",
      "openai",
      "--model",
      "second-model",
      "--root",
      targetRoot,
    ]);
    expect(second.status, second.stderr).toBe(0);
    expect(
      await readJson(
        join(targetRoot, "local", "models", "default.config.json"),
      ),
    ).toMatchObject({ provider: "ollama", model: "first-model" });

    const forced = runInit([
      "--provider",
      "openai",
      "--model",
      "second-model",
      "--root",
      targetRoot,
      "--force",
    ]);
    expect(forced.status, forced.stderr).toBe(0);
    expect(
      await readJson(
        join(targetRoot, "local", "models", "default.config.json"),
      ),
    ).toMatchObject({ provider: "openai", model: "second-model" });
  });
});
