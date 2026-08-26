import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  installRuntimeWebUiUserServices,
  WEB_UI_OPEN_UNIT,
  WEB_UI_SERVER_UNIT,
} from "../../../scripts/install-runtime-web-ui-user-services.js";
import {
  openWebUiInWslg,
  resolveRuntimeServiceWebUiSettings,
  runRuntimeServiceWebUiAutoOpen,
  waitForWebUiReady,
} from "../../web-ui/runtime-service-auto-open.js";
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

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("runtime-service Web UI integration", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function createRuntimeRoot(enabled: boolean): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-web-ui-service-"));
    tempDirs.push(rootDir);
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        ...requiredModelConfig,
        requestRunner: { configRef: "./request-runner.config.json" },
        webUi: { openOnRuntimeServiceStart: enabled },
      }),
      "utf-8",
    );
    await writeFile(
      join(rootDir, "request-runner.config.json"),
      JSON.stringify(createTestRunnerConfig()),
      "utf-8",
    );
    return rootDir;
  }

  test("keeps Web UI and browser disabled when the configuration flag is false", async () => {
    const rootDir = await createRuntimeRoot(false);
    const settings = resolveRuntimeServiceWebUiSettings({ rootDir, env: {} });
    const waitUntilReady = vi.fn();
    const openBrowser = vi.fn();

    const result = await runRuntimeServiceWebUiAutoOpen({
      settings,
      waitUntilReady,
      openBrowser,
    });

    expect(settings.enabled).toBe(false);
    expect(result).toEqual({ status: "disabled" });
    expect(waitUntilReady).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  test("reads the auto-open flag before provider and model setup is complete", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-web-ui-service-"));
    tempDirs.push(rootDir);
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        webUi: { openOnRuntimeServiceStart: true },
        models: { providers: { ollama: { type: "ollama" } } },
      }),
      "utf-8",
    );

    const settings = resolveRuntimeServiceWebUiSettings({ rootDir, env: {} });

    expect(settings.enabled).toBe(true);
  });

  test("keeps auto-open disabled when the runtime config or flag is absent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-web-ui-service-"));
    tempDirs.push(rootDir);

    expect(
      resolveRuntimeServiceWebUiSettings({ rootDir, env: {} }).enabled,
    ).toBe(false);

    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({ models: {} }),
      "utf-8",
    );
    expect(
      resolveRuntimeServiceWebUiSettings({ rootDir, env: {} }).enabled,
    ).toBe(false);
  });

  test("keeps malformed runtime config JSON as an auto-open error", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-web-ui-service-"));
    tempDirs.push(rootDir);
    await writeFile(
      join(rootDir, "runtime.config.json"),
      "{ malformed",
      "utf-8",
    );

    expect(() =>
      resolveRuntimeServiceWebUiSettings({ rootDir, env: {} }),
    ).toThrow("Invalid runtime config JSON");
  });

  test.each([
    [
      "a non-object Web UI section",
      { webUi: "yes" },
      "webUi must be an object",
    ],
    [
      "a non-boolean auto-open flag",
      { webUi: { openOnRuntimeServiceStart: "true" } },
      "webUi.openOnRuntimeServiceStart must be a boolean",
    ],
  ])(
    "rejects %s without validating model setup",
    async (_case, config, issue) => {
      const rootDir = await mkdtemp(join(tmpdir(), "abot-web-ui-service-"));
      tempDirs.push(rootDir);
      await writeFile(
        join(rootDir, "runtime.config.json"),
        JSON.stringify(config),
        "utf-8",
      );

      expect(() =>
        resolveRuntimeServiceWebUiSettings({ rootDir, env: {} }),
      ).toThrow(issue);
    },
  );

  test("does not treat runtime config read failures as a missing file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-web-ui-service-"));
    tempDirs.push(rootDir);
    await mkdir(join(rootDir, "runtime.config.json"));

    expect(() =>
      resolveRuntimeServiceWebUiSettings({ rootDir, env: {} }),
    ).toThrow();
  });

  test("resolves a reachable browser URL from a wildcard listen address", async () => {
    const rootDir = await createRuntimeRoot(true);

    const settings = resolveRuntimeServiceWebUiSettings({
      rootDir,
      env: {
        LLM_RUNTIME_WEB_HOST: "0.0.0.0",
        LLM_RUNTIME_WEB_PORT: "6200",
      },
    });

    expect(settings).toEqual({
      enabled: true,
      listenHost: "0.0.0.0",
      port: 6200,
      browserUrl: "http://127.0.0.1:6200/",
      healthUrl: "http://127.0.0.1:6200/web-health",
    });
  });

  test("waits through transient health failures and then reports readiness", async () => {
    let currentTime = 0;
    const fetchHealth = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await waitForWebUiReady("http://127.0.0.1/web-health", {
      fetch: fetchHealth,
      sleep: async (durationMs) => {
        currentTime += durationMs;
      },
      timeoutMs: 3,
      intervalMs: 1,
      now: () => currentTime,
    });

    expect(result).toEqual({ ready: true, attempts: 3 });
    expect(fetchHealth).toHaveBeenCalledTimes(3);
  });

  test("bounds readiness polling by a real deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchHealth = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("connection refused")),
          { once: true },
        );
      });
    });

    const readiness = waitForWebUiReady("http://127.0.0.1/web-health", {
      fetch: fetchHealth,
      timeoutMs: 30_000,
      intervalMs: 250,
      requestTimeoutMs: 2_000,
    });
    await vi.runAllTimersAsync();
    const result = await readiness;

    expect(result.ready).toBe(false);
    expect(Date.now()).toBeLessThanOrEqual(30_000);
    expect(fetchHealth).toHaveBeenCalledTimes(result.attempts);
  });

  test("opens exactly once after readiness and keeps opener failures nonfatal", async () => {
    const rootDir = await createRuntimeRoot(true);
    const settings = resolveRuntimeServiceWebUiSettings({ rootDir, env: {} });
    const waitUntilReady = vi
      .fn()
      .mockResolvedValue({ ready: true, attempts: 2 });
    const openBrowser = vi.fn().mockRejectedValue(new Error("display missing"));

    const result = await runRuntimeServiceWebUiAutoOpen({
      settings,
      waitUntilReady,
      openBrowser,
    });

    expect(waitUntilReady).toHaveBeenCalledOnce();
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(openBrowser).toHaveBeenCalledWith("http://127.0.0.1:5177/");
    expect(result).toEqual({
      status: "open-failed",
      url: "http://127.0.0.1:5177/",
      attempts: 2,
      error: "display missing",
    });
  });

  test("selects Chromium and supplies a complete WSLg environment", async () => {
    const spawnBrowser = vi.fn().mockResolvedValue(undefined);

    await openWebUiInWslg("http://127.0.0.1:5177/", {
      env: {},
      userId: 1234,
      exists: (path) => path === "/mnt/wslg" || path === "/snap/bin/chromium",
      spawnBrowser,
    });

    expect(spawnBrowser).toHaveBeenCalledOnce();
    expect(spawnBrowser).toHaveBeenCalledWith(
      "/snap/bin/chromium",
      ["--new-window", "http://127.0.0.1:5177/"],
      expect.objectContaining({
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        XDG_RUNTIME_DIR: "/run/user/1234",
        PULSE_SERVER: "unix:/mnt/wslg/PulseServer",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus",
      }),
    );
  });

  test("installs versioned production-only units without starting services", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "abot-web-ui-units-"));
    tempDirs.push(installRoot);
    const unitDir = join(installRoot, "units");
    await mkdir(unitDir, { recursive: true });
    const systemctlCalls: readonly string[][] = [];
    const mutableCalls = systemctlCalls as string[][];

    await installRuntimeWebUiUserServices({
      rootDir: REPOSITORY_ROOT,
      unitDir,
      nodePath: "/usr/bin/node",
      runSystemctl: async (args) => {
        mutableCalls.push([...args]);
      },
    });

    const serverUnit = await readFile(
      join(unitDir, WEB_UI_SERVER_UNIT),
      "utf-8",
    );
    const openUnit = await readFile(join(unitDir, WEB_UI_OPEN_UNIT), "utf-8");

    expect(systemctlCalls).toEqual([
      ["daemon-reload"],
      ["enable", WEB_UI_OPEN_UNIT],
    ]);
    expect(serverUnit).toContain(`WorkingDirectory=${REPOSITORY_ROOT}`);
    expect(serverUnit).not.toContain(`WorkingDirectory="${REPOSITORY_ROOT}"`);
    expect(`${serverUnit}\n${openUnit}`).not.toContain(
      "llm-runtime-dev.service",
    );
    expect(serverUnit).toContain("PartOf=llm-runtime.service");
    expect(serverUnit).toContain("ExecCondition=");
    expect(serverUnit).not.toContain("Restart=");
    expect(openUnit).toContain(`Wants=${WEB_UI_SERVER_UNIT}`);
    expect(openUnit).toContain("WantedBy=llm-runtime.service");
    expect(openUnit).toContain("RemainAfterExit=yes");
    expect(openUnit).toContain("Environment=WAYLAND_DISPLAY=wayland-0");
    expect(openUnit).not.toContain("--now");
  });
});
