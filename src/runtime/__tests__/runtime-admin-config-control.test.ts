import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  getRuntimeConfig,
  getRuntimeConfigSchema,
  patchRuntimeConfig,
  validateRuntimeConfigCandidate,
} from "../admin/config-control.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";

const TEST_PROVIDER_ID = "test-provider";
const TEST_PROFILE_ID = "test-profile";

const requiredRequestRunner = {
  models: {
    providers: {
      [TEST_PROVIDER_ID]: { type: "ollama" },
    },
    profiles: {
      [TEST_PROFILE_ID]: {
        provider: TEST_PROVIDER_ID,
        model: "test:model",
        contextWindowTokens: 32_768,
      },
    },
  },
  requestRunner: {
    configRef: "./request-runner.config.json",
  },
};

function createTestRunnerConfig() {
  return {
    models: {
      defaults: {
        profileId: TEST_PROFILE_ID,
        steps: Object.fromEntries(
          REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, TEST_PROFILE_ID]),
        ),
      },
    },
    context: {
      outputReserveTokens: 4_096,
      safetyReserveTokens: 1_200,
      attachmentReserveTokens: 1_024,
    },
    steps: Object.fromEntries(
      REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, { timeoutMs: 90_000 }]),
    ),
  };
}

describe("runtime admin config control", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempRoot(name: string): Promise<string> {
    const rootDir = `/tmp/${name}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    tempDirs.push(rootDir);
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(createTestRunnerConfig()),
      "utf-8",
    );
    return rootDir;
  }

  test("reads file and effective config with secret values redacted", async () => {
    const rootDir = await createTempRoot("llm-runtime-admin-read");
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          agentBridgeToken: "secret-token",
          models: {
            ...requiredRequestRunner.models,
            providers: {
              [TEST_PROVIDER_ID]: {
                type: "ollama",
                settings: { vendorApiKey: "provider-secret" },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = getRuntimeConfig({ rootDir, env: {} });

    expect(result.metadata).toEqual({
      rootDir,
      configPath: join(rootDir, "runtime.config.json"),
      exists: true,
    });
    expect(result.fileConfig).toMatchObject({
      agentBridgeToken: "[redacted]",
      models: {
        providers: {
          [TEST_PROVIDER_ID]: {
            settings: { vendorApiKey: "[redacted]" },
          },
        },
      },
    });
    expect(result.effectiveConfig.runtimeId).toBe("prod");
    expect(result.effectiveConfig.agentBridgeToken).toBe("[redacted]");
  });

  test("returns the runtime config schema", () => {
    expect(getRuntimeConfigSchema()).toMatchObject({
      title: "abot config",
      type: "object",
      properties: {
        paths: expect.any(Object),
        plugins: expect.any(Object),
        requestRunner: expect.any(Object),
      },
    });
  });

  test("validates full config and deep patch candidates without writing", async () => {
    const rootDir = await createTempRoot("llm-runtime-admin-validate");
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredRequestRunner,
          plugins: {
            enabled: true,
            allow: ["filesystem"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    expect(
      validateRuntimeConfigCandidate({
        rootDir,
        patch: {
          plugins: {
            deny: ["filesystem.read_file"],
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      config: {
        plugins: {
          enabled: true,
          allow: ["filesystem"],
          deny: ["filesystem.read_file"],
        },
      },
    });

    expect(
      validateRuntimeConfigCandidate({
        rootDir,
        config: {
          ...requiredRequestRunner,
          paths: {
            sessionsDir: "",
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      issues: ["paths.sessionsDir must be a non-empty string"],
    });
  });

  test("patches config atomically and creates backup when file exists", async () => {
    const rootDir = await createTempRoot("llm-runtime-admin-patch");
    const configPath = join(rootDir, "runtime.config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          ...requiredRequestRunner,
          logging: {
            enabled: true,
          },
          plugins: {
            enabled: true,
            allow: ["memory"],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await patchRuntimeConfig({
      rootDir,
      patch: {
        logging: {
          enabled: false,
        },
        plugins: {
          deny: ["memory.memory_delete"],
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      restartRequired: true,
      metadata: {
        rootDir,
        configPath,
        exists: true,
      },
      config: {
        logging: {
          enabled: false,
        },
        plugins: {
          enabled: true,
          allow: ["memory"],
          deny: ["memory.memory_delete"],
        },
      },
    });
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
    if (!result.ok) {
      throw new Error("expected config patch to succeed");
    }
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual(
      result.config,
    );
  });

  test("rejects invalid patch without writing", async () => {
    const rootDir = await createTempRoot("llm-runtime-admin-invalid-patch");
    const configPath = join(rootDir, "runtime.config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          ...requiredRequestRunner,
          timeouts: {
            modelStepTimeoutMs: 90_000,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await patchRuntimeConfig({
      rootDir,
      patch: {
        timeouts: {
          modelStepTimeoutMs: 0,
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      restartRequired: false,
      issues: ["timeouts.modelStepTimeoutMs must be a positive number"],
    });
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({
      ...requiredRequestRunner,
      timeouts: {
        modelStepTimeoutMs: 90_000,
      },
    });
  });
});
