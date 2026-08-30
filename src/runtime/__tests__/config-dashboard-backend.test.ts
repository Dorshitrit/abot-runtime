import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";

function createRunnerConfig(timeoutMs = 20_000) {
  return {
    schemaVersion: 2,
    models: {
      defaults: {
        profileId: "gemma-e4b",
        steps: { "tool_payload.raw": "toolPayload.raw" },
      },
    },
    context: {
      outputReserveTokens: 4_096,
      safetyReserveTokens: 1_200,
      attachmentReserveTokens: 1_024,
    },
    stepDefaults: { timeoutMs },
    steps: {},
  };
}

describe("config dashboard backend", () => {
  let rootDir = "";

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { force: true, recursive: true });
      rootDir = "";
    }
  });

  test("includes and saves inline model profiles from runtime config", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "abot-config-dashboard-"));
    await mkdir(join(rootDir, "local", "models"), { recursive: true });
    await writeFile(
      join(rootDir, "local", "runtime.config.json"),
      `${JSON.stringify(
        {
          models: {
            profiles: {
              "gpt-5.6-terra": {
                provider: "openai",
                model: "gpt-5.6-terra",
                contextWindowTokens: 32_768,
                calibration: {
                  "supervisor.decision": {
                    format: "json",
                  },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      join(rootDir, "local", "models", "gemma-e4b.config.json"),
      `${JSON.stringify(
        {
          model: "gemma4:e4b-it-q4_K_M",
          contextWindowTokens: 32_768,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const snapshot = await getConfigDashboardSnapshot({
      rootDir,
      configPath: "local/runtime.config.json",
    });

    expect(snapshot.modelSteps).toEqual([...REQUEST_INVOKED_STEP_IDS]);
    expect(snapshot.files.models[0]?.id).toBe("gpt-5.6-terra");
    expect(snapshot.files.models[0]?.config.model).toBe("gpt-5.6-terra");
    expect(
      snapshot.files.models.some((model) => model.id === "gemma-e4b"),
    ).toBe(true);

    await saveConfigDashboardFile({
      rootDir,
      configPath: "local/runtime.config.json",
      kind: "model",
      id: "gpt-5.6-terra",
      config: {
        provider: "openai",
        model: "gpt-5.6-terra",
        contextWindowTokens: 32_768,
        calibration: {
          "supervisor.decision": {
            format: "json",
            generation: {
              temperature: 0.2,
            },
          },
        },
      },
    });

    const runtimeConfig = JSON.parse(
      await readFile(join(rootDir, "local", "runtime.config.json"), "utf-8"),
    );
    expect(
      runtimeConfig.models.profiles["gpt-5.6-terra"].calibration[
        "supervisor.decision"
      ].generation.temperature,
    ).toBe(0.2);
    expect(
      await readFile(
        join(rootDir, "local", "models", "gemma-e4b.config.json"),
        "utf-8",
      ),
    ).toContain("gemma4:e4b-it-q4_K_M");
  });

  test("resolves and saves the generic runtime runner config", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "abot-config-dashboard-runtime-"));
    await mkdir(join(rootDir, "local"), { recursive: true });
    await writeFile(
      join(rootDir, "local", "runtime.config.json"),
      `${JSON.stringify(
        {
          requestRunner: {
            configRef: "./runner.config.json",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const runnerConfig = createRunnerConfig();
    await writeFile(
      join(rootDir, "local", "runner.config.json"),
      `${JSON.stringify(runnerConfig, null, 2)}\n`,
      "utf-8",
    );

    const snapshot = await getConfigDashboardSnapshot({
      rootDir,
      configPath: "local/runtime.config.json",
    });

    expect(snapshot.files.requestRunner).toMatchObject({
      kind: "requestRunner",
      id: "requestRunner",
      path: "local/runner.config.json",
      exists: true,
      config: runnerConfig,
    });

    const updatedRunnerConfig = createRunnerConfig(30_000);
    await saveConfigDashboardFile({
      rootDir,
      configPath: "local/runtime.config.json",
      kind: "requestRunner",
      config: updatedRunnerConfig,
    });

    expect(
      JSON.parse(
        await readFile(join(rootDir, "local", "runner.config.json"), "utf-8"),
      ),
    ).toEqual(updatedRunnerConfig);
  });

  test("rejects an unsupported runner version before creating a backup", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "abot-config-dashboard-version-"));
    await mkdir(join(rootDir, "local"), { recursive: true });
    await writeFile(
      join(rootDir, "local", "runtime.config.json"),
      `${JSON.stringify({ requestRunner: { configRef: "./runner.json" } })}\n`,
      "utf-8",
    );
    const runnerPath = join(rootDir, "local", "runner.json");
    const original = `${JSON.stringify(createRunnerConfig(), null, 2)}\n`;
    await writeFile(runnerPath, original, "utf-8");

    await expect(
      saveConfigDashboardFile({
        rootDir,
        configPath: "local/runtime.config.json",
        kind: "requestRunner",
        config: { ...createRunnerConfig(), schemaVersion: 3 },
      }),
    ).rejects.toThrow(
      "schemaVersion must be 2 or omitted for the legacy v1 format",
    );
    await expect(readFile(runnerPath, "utf-8")).resolves.toBe(original);
    expect(await readdir(join(rootDir, "local"))).toEqual([
      "runner.json",
      "runtime.config.json",
    ]);
  });

  test("does not overwrite an existing future runner config with an older payload", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "abot-config-dashboard-existing-"));
    await mkdir(join(rootDir, "local"), { recursive: true });
    await writeFile(
      join(rootDir, "local", "runtime.config.json"),
      `${JSON.stringify({ requestRunner: { configRef: "./runner.json" } })}\n`,
      "utf-8",
    );
    const runnerPath = join(rootDir, "local", "runner.json");
    const original = `${JSON.stringify(
      { ...createRunnerConfig(), schemaVersion: 3 },
      null,
      2,
    )}\n`;
    await writeFile(runnerPath, original, "utf-8");

    await expect(
      saveConfigDashboardFile({
        rootDir,
        configPath: "local/runtime.config.json",
        kind: "requestRunner",
        config: createRunnerConfig(),
      }),
    ).rejects.toThrow(
      "schemaVersion must be 2 or omitted for the legacy v1 format",
    );
    await expect(readFile(runnerPath, "utf-8")).resolves.toBe(original);
    expect(await readdir(join(rootDir, "local"))).toHaveLength(2);
  });

  test("validates a complete legacy candidate before writing it", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "abot-config-dashboard-legacy-"));
    await mkdir(join(rootDir, "local"), { recursive: true });
    await writeFile(
      join(rootDir, "local", "runtime.config.json"),
      `${JSON.stringify({ requestRunner: { configRef: "./runner.json" } })}\n`,
      "utf-8",
    );
    const runnerPath = join(rootDir, "local", "runner.json");
    const original = await readFile(
      join(
        import.meta.dirname,
        "fixtures",
        "public-v1.0.0",
        "request-runner.config.example.json",
      ),
      "utf-8",
    );
    await writeFile(runnerPath, original, "utf-8");
    const candidate = JSON.parse(original) as {
      models: { defaults: { steps: Record<string, string> } };
    };
    delete candidate.models.defaults.steps["supervisor.decision"];

    await expect(
      saveConfigDashboardFile({
        rootDir,
        configPath: "local/runtime.config.json",
        kind: "requestRunner",
        config: candidate,
      }),
    ).rejects.toThrow(
      "models.defaults.steps.supervisor.decision is required by the legacy v1 format",
    );
    await expect(readFile(runnerPath, "utf-8")).resolves.toBe(original);
    expect(await readdir(join(rootDir, "local"))).toHaveLength(2);
  });
});
