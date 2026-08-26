import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  processDebugLogger,
  resetDebugLoggerConfig,
  traceDebug,
} from "../observability/debug-logger.js";
import { appendTraceLineWithRotation } from "../observability/log-rotation.js";
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

function createTempPath(name: string): string {
  return join(
    "/tmp",
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function buildRotationTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

describe("traceDebug", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(async () => {
    await processDebugLogger.drain();
    process.chdir(originalCwd);
    resetDebugLoggerConfig();
    delete process.env.LLM_RUNTIME_TRACE;
    delete process.env.LLM_RUNTIME_TRACE_FILE;
    delete process.env.LLM_RUNTIME_PROFILE;
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function createTempLogDir(name: string): Promise<string> {
    const dir = createTempPath(name);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  test("writes jsonl log line when trace is enabled", async () => {
    const logDir = await createTempLogDir("runtime-debug-env");
    const logPath = join(logDir, "runtime-debug.test.jsonl");
    process.env.LLM_RUNTIME_TRACE = "1";
    process.env.LLM_RUNTIME_TRACE_FILE = logPath;

    traceDebug("test.scope", "event.one", { value: 42 });

    await processDebugLogger.drain();
    const raw = await readFile(logPath, "utf-8");
    const line = raw.trim().split("\n").at(-1) || "";
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.scope).toBe("test.scope");
    expect(parsed.event).toBe("event.one");
    expect(parsed.value).toBe(42);
    expect(typeof parsed.ts).toBe("string");
  });

  test("writes to configured trace file without env path", async () => {
    const logDir = await createTempLogDir("runtime-debug-configured");
    const logPath = join(logDir, "runtime-debug.config.test.jsonl");

    configureDebugLogger({
      traceFile: logPath,
    });
    traceDebug("test.scope", "event.configured", { value: "configured" });

    await processDebugLogger.drain();
    const raw = await readFile(logPath, "utf-8");
    const line = raw.trim().split("\n").at(-1) || "";
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.scope).toBe("test.scope");
    expect(parsed.event).toBe("event.configured");
    expect(parsed.value).toBe("configured");
  });

  test("resolves the default trace file from the active runtime profile", async () => {
    const runtimeRoot = await createTempLogDir("runtime-debug-profile-default");
    const runtimeConfigPath = join(runtimeRoot, "runtime.config.json");
    const expectedLogPath = join(
      runtimeRoot,
      ".runtime",
      "prod",
      "logs",
      "runtime-debug.jsonl",
    );
    const legacyLogPath = join(
      runtimeRoot,
      ".runtime",
      "logs",
      "runtime-debug.jsonl",
    );

    await writeFile(
      runtimeConfigPath,
      JSON.stringify({
        ...requiredModelConfig,
        requestRunner: {
          configRef: "./request-runner.config.json",
        },
        environment: {
          default: "prod",
          profiles: {
            prod: {
              paths: {
                runtimeDir: ".runtime/prod",
              },
            },
            dev: {
              paths: {
                runtimeDir: ".runtime/dev",
              },
            },
          },
        },
      }),
      "utf-8",
    );
    await writeFile(
      join(runtimeRoot, "request-runner.config.json"),
      JSON.stringify(createTestRunnerConfig()),
      "utf-8",
    );
    process.chdir(runtimeRoot);
    process.env.LLM_RUNTIME_TRACE = "1";

    traceDebug("test.scope", "event.profile.default", { value: "prod" });

    await processDebugLogger.drain();
    const raw = await readFile(expectedLogPath, "utf-8");
    expect(raw).toContain('"event":"event.profile.default"');
    await expect(stat(legacyLogPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("env overrides configured enablement and trace file", async () => {
    const logDir = await createTempLogDir("runtime-debug-env-override");
    const configuredPath = join(logDir, "configured.jsonl");
    const envPath = join(logDir, "env.jsonl");
    process.env.LLM_RUNTIME_TRACE = "1";
    process.env.LLM_RUNTIME_TRACE_FILE = envPath;

    configureDebugLogger({
      enabled: false,
      traceFile: configuredPath,
    });
    traceDebug("test.scope", "event.env", { value: "env" });

    await processDebugLogger.drain();
    const raw = await readFile(envPath, "utf-8");
    expect(raw).toContain('"event":"event.env"');
    await expect(stat(configuredPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rotates the active trace file and preserves the newest line in the fresh file", async () => {
    const logDir = await createTempLogDir("runtime-debug-rotation");
    const logPath = join(logDir, "runtime-debug.jsonl");
    await writeFile(logPath, "x".repeat(256), "utf-8");

    configureDebugLogger({
      traceFile: logPath,
      rotation: {
        maxFileSizeMb: 0.0001,
        maxFiles: 10,
        maxAgeDays: 7,
      },
    });
    traceDebug("test.scope", "event.rotated", { value: "fresh" });

    await processDebugLogger.drain();
    const activeRaw = await readFile(logPath, "utf-8");
    const rotatedEntries = (await readdir(logDir)).filter(
      (entry) => entry !== "runtime-debug.jsonl",
    );
    expect(rotatedEntries).toHaveLength(1);
    expect(activeRaw).toContain('"event":"event.rotated"');
    const rotatedRaw = await readFile(join(logDir, rotatedEntries[0]), "utf-8");
    expect(rotatedRaw).toBe("x".repeat(256));
  });

  test("deletes oldest rotated files beyond maxFiles and age-expired rotated files", async () => {
    const logDir = await createTempLogDir("runtime-debug-cleanup");
    const logPath = join(logDir, "runtime-debug.jsonl");
    const now = Date.now();
    const staleTimestamp = buildRotationTimestamp(
      new Date(now - 10 * 24 * 60 * 60 * 1000),
    );
    const olderTimestamp = buildRotationTimestamp(
      new Date(now - 3 * 60 * 60 * 1000),
    );
    const newerTimestamp = buildRotationTimestamp(
      new Date(now - 2 * 60 * 60 * 1000),
    );
    const newestTimestamp = buildRotationTimestamp(
      new Date(now - 1 * 60 * 60 * 1000),
    );

    await writeFile(logPath, "", "utf-8");
    await Promise.all([
      writeFile(
        join(logDir, `runtime-debug.${staleTimestamp}.jsonl`),
        "stale\n",
        "utf-8",
      ),
      writeFile(
        join(logDir, `runtime-debug.${olderTimestamp}.jsonl`),
        "older\n",
        "utf-8",
      ),
      writeFile(
        join(logDir, `runtime-debug.${newerTimestamp}.jsonl`),
        "newer\n",
        "utf-8",
      ),
      writeFile(
        join(logDir, `runtime-debug.${newestTimestamp}.jsonl`),
        "newest\n",
        "utf-8",
      ),
    ]);

    configureDebugLogger({
      traceFile: logPath,
      rotation: {
        maxFileSizeMb: 20,
        maxFiles: 2,
        maxAgeDays: 7,
      },
    });
    traceDebug("test.scope", "event.cleanup", {});

    await processDebugLogger.drain();
    const rotatedEntries = (await readdir(logDir))
      .filter((entry) => entry !== "runtime-debug.jsonl")
      .sort();

    expect(rotatedEntries).toEqual([
      `runtime-debug.${newerTimestamp}.jsonl`,
      `runtime-debug.${newestTimestamp}.jsonl`,
    ]);
  });

  test("does not throw when rotated-file cleanup fails", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    await expect(
      appendTraceLineWithRotation({
        traceFile: "/tmp/runtime-debug.jsonl",
        line: JSON.stringify({ event: "test" }),
        rotation: {
          maxFileSizeMb: 20,
          maxFiles: 0,
          maxAgeDays: 7,
        },
        onWarning: (warning) =>
          warnings.push(warning as Record<string, unknown>),
        fileOps: {
          mkdir: async () => undefined,
          appendFile: async () => undefined,
          readdir: (async () => [
            "runtime-debug.2026-05-11T13-20-00-000Z.jsonl",
          ]) as never,
          rename: async () => undefined,
          stat: async (path) =>
            ({
              size: 0,
              isFile: () => path !== "/tmp",
            }) as never,
          unlink: async () => {
            const error = new Error("denied") as Error & { code?: string };
            error.code = "EACCES";
            throw error;
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toEqual([
      expect.objectContaining({
        event: "cleanup.failed",
        traceFile: "/tmp/runtime-debug.jsonl",
      }),
    ]);
  });
});
