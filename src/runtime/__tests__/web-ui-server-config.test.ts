import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  resolveWebUiEnvironmentConfig,
  startWebUiServer,
} from "../../web-ui/server.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";

const TEST_PROVIDER_ID = "test-provider";
const TEST_PROFILE_ID = "test-profile";

const requiredModelConfig = {
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

async function writeTestRunnerConfig(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, "request-runner.config.json"),
    JSON.stringify(createTestRunnerConfig()),
  );
}

describe("web ui server config", () => {
  let rootDir = "";

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = "";
    }
  });

  test("reads environment options from runtime config", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "llm-runtime-web-config-"));
    await writeTestRunnerConfig(rootDir);
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredModelConfig,
          requestRunner: {
            configRef: "./request-runner.config.json",
          },
          environment: {
            default: "preview",
            profiles: {
              preview: {
                paths: {
                  runtimeDir: ".runtime/preview",
                },
              },
              staging: {
                paths: {
                  runtimeDir: ".runtime/staging",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const config = resolveWebUiEnvironmentConfig({ rootDir });

    expect(config.defaultEnvironmentId).toBe("preview");
    expect(config.environments).toEqual([
      { id: "preview", label: "preview", isDefault: true },
      { id: "staging", label: "staging", isDefault: false },
    ]);
  });

  test("lets explicit web ui environment choose the default option", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "llm-runtime-web-config-"));
    await writeTestRunnerConfig(rootDir);
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify(
        {
          ...requiredModelConfig,
          requestRunner: {
            configRef: "./request-runner.config.json",
          },
          environment: {
            default: "preview",
            profiles: {
              preview: {
                paths: {
                  runtimeDir: ".runtime/preview",
                },
              },
              staging: {
                paths: {
                  runtimeDir: ".runtime/staging",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const config = resolveWebUiEnvironmentConfig({
      rootDir,
      defaultEnvironmentId: "staging",
    });

    expect(config.defaultEnvironmentId).toBe("staging");
    expect(config.environments).toEqual([
      { id: "preview", label: "preview", isDefault: false },
      { id: "staging", label: "staging", isDefault: true },
    ]);
  });

  test.each([
    ["missing", null],
    ["empty", "{}"],
    ["partial", JSON.stringify({ models: { providers: {} } })],
    ["malformed", "{"],
  ])(
    "falls back to one Web environment for %s runtime config",
    async (_case, contents) => {
      rootDir = await mkdtemp(join(tmpdir(), "llm-runtime-web-config-"));
      if (contents !== null) {
        await writeFile(join(rootDir, "runtime.config.json"), contents);
      }

      expect(resolveWebUiEnvironmentConfig({ rootDir })).toEqual({
        defaultEnvironmentId: "prod",
        environments: [{ id: "prod", label: "prod", isDefault: true }],
      });
    },
  );

  test.each([
    ["empty", "{}"],
    ["partial", JSON.stringify({ models: { providers: {} } })],
    ["malformed", "{"],
  ])(
    "starts the real Web server with %s runtime config",
    async (_case, contents) => {
      rootDir = await mkdtemp(join(tmpdir(), "llm-runtime-web-config-"));
      await writeFile(join(rootDir, "runtime.config.json"), contents);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const server = startWebUiServer({
        rootDir,
        configPath: "runtime.config.json",
        host: "127.0.0.1",
        port: 0,
        appDir: join(process.cwd(), "src/web-ui/app"),
      });
      try {
        await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      } finally {
        await server.close();
        log.mockRestore();
      }
    },
  );
});
