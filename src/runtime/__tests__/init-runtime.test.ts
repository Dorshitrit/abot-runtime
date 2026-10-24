import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../config.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import { resolveModelStepTimeout } from "../model/model-step-timeout-policy.js";

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
      { format: "json", generation: { temperature: 0, reasoningEffort: "none" } },
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
      { format: "json", timeoutMs: 300_000 },
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
      { format: "json" },
    ],
  ] as const)(
    "creates a generic default profile for %s",
    async (provider, model, expectedProviders, expectedAccountingMode, expectedCompaction) => {
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
      expect(runnerConfig.schemaVersion).toBe(2);
      expect(asRecord(runnerDefaults.steps)).toEqual({
        "supervisor.response": "default",
        "worker.result": "default",
        "execution.response": "default",
        "tool_payload.raw": "toolPayload.raw",
      });
      expect(asRecord(runnerConfig.stepDefaults)).toEqual({
        timeoutMs: 90_000,
      });
      expect(Object.keys(asRecord(runnerConfig.steps))).toEqual([
        "context.compact",
        "supervisor.response",
        "execution.response",
      ]);
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
      const expectedTokenEstimation = provider === "ollama"
        ? {
            asciiCharactersPerToken: 3,
            nonAsciiBytesPerToken: 2,
            messageOverheadTokens: 6,
          }
        : undefined;
      expect(asRecord(modelConfig.context).tokenEstimation).toEqual(
        expectedTokenEstimation,
      );
      expect(asRecord(modelConfig.calibration)["context.compact"]).toEqual(
        expectedCompaction,
      );
      expect(modelConfig.supportsThinking).toBeUndefined();
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
      expect(loaded.models?.profiles?.default.context?.tokenEstimation).toEqual(
        expectedTokenEstimation,
      );
      expect(loaded.models?.profiles?.default.calibration?.["context.compact"]).toEqual(
        expectedCompaction,
      );
      expect(loaded.models?.profiles?.default.supportsThinking).toBeUndefined();
      expect(loaded.modelExecutionPolicies?.default).toEqual(
        provider === "openai" ? { policy: "execution-agent-v1" } : undefined,
      );
      const loadedRunner = loadRequestRunnerConfig({
        configPath: join(
          targetRoot,
          "local",
          "request-runner.config.json",
        ),
      });
      expect(loadedRunner.steps["context.compact"].timeoutMs).toBe(180_000);
      const compactionTimeout = resolveModelStepTimeout({
        modelStep: "context.compact",
        fallbackTimeoutMs: loadedRunner.steps["context.compact"].timeoutMs,
        modelPolicy: createRequestModelPolicy({
          platformPolicy: loaded.models, runnerConfig: loadedRunner,
        }),
      });
      expect(compactionTimeout.timeoutMs).toBe(
        provider === "openai" ? 300_000 : 180_000,
      );
      const rawPayloadTimeout = resolveModelStepTimeout({
        modelStep: "tool_payload.raw",
        fallbackTimeoutMs: loadedRunner.steps["tool_payload.raw"].timeoutMs,
        modelPolicy: createRequestModelPolicy({
          platformPolicy: loaded.models, runnerConfig: loadedRunner,
        }),
      });
      expect(rawPayloadTimeout).toMatchObject({
        timeoutMs: provider === "openai" ? 300_000 : 90_000,
        source: provider === "openai" ? "model_calibration" : "runner",
      });
      const otherStepTimeouts = Object.entries(loadedRunner.steps)
        .filter(([stepId]) => stepId !== "context.compact")
        .map(([, step]) => step.timeoutMs);
      expect(new Set(otherStepTimeouts)).toEqual(new Set([90_000]));
      const expectedResponseMethodologyRefs = [
        "../methodologies/response-ux.md",
        "../methodologies/memory-informed-response.md",
      ];
      expect(
        loadedRunner.steps["supervisor.response"]?.instructionBlocks?.map(
          (block) => block.ref,
        ),
      ).toEqual(expectedResponseMethodologyRefs);
      expect(
        loadedRunner.steps["execution.response"]?.instructionBlocks?.map(
          (block) => block.ref,
        ),
      ).toEqual(expectedResponseMethodologyRefs);
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
    const modelPath = join(targetRoot, "local", "models", "default.config.json");
    const existingModel = await readJson(modelPath);
    delete asRecord(existingModel.context).tokenEstimation;
    delete asRecord(asRecord(existingModel.calibration)["context.compact"]).generation;
    const originalModel = JSON.stringify(existingModel);
    await writeFile(modelPath, originalModel, "utf-8");
    const runnerConfigPath = join(
      targetRoot,
      "local",
      "request-runner.config.json",
    );
    const publishedV1Runner = await readFile(
      join(
        rootDir,
        "src",
        "runtime",
        "__tests__",
        "fixtures",
        "public-v1.0.0",
        "request-runner.config.example.json",
      ),
      "utf-8",
    );
    await writeFile(runnerConfigPath, publishedV1Runner, "utf-8");

    const second = runInit([
      "--provider",
      "openai",
      "--model",
      "second-model",
      "--root",
      targetRoot,
    ]);
    expect(second.status, second.stderr).toBe(0);
    expect(await readFile(runnerConfigPath, "utf-8")).toBe(publishedV1Runner);
    expect(await readFile(modelPath, "utf-8")).toBe(originalModel);
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
    expect((await readJson(runnerConfigPath)).schemaVersion).toBe(2);
  });
});
