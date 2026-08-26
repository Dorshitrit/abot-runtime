import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { inspectRuntimeConfigFileWithMeta } from "../runtime/config/loader.js";
import { validateRuntimeWebUiConfig } from "../runtime/config/validation.js";
import { resolveWebUiAddress } from "./web-ui-address.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export type RuntimeServiceWebUiSettings = Readonly<{
  enabled: boolean;
  listenHost: string;
  port: number;
  browserUrl: string;
  healthUrl: string;
}>;

export type ReadinessResult = Readonly<{
  ready: boolean;
  attempts: number;
  lastError?: string;
}>;

export type AutoOpenResult =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "opened"; url: string; attempts: number }>
  | Readonly<{
      status: "not-ready" | "open-failed";
      url: string;
      attempts: number;
      error: string;
    }>;

type FetchResponse = Readonly<{ ok: boolean; status: number }>;
type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<FetchResponse>;

type SpawnBrowser = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function resolveRuntimeServiceWebUiSettings(params: {
  rootDir: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): RuntimeServiceWebUiSettings {
  const env = params.env ?? process.env;
  const source = inspectRuntimeConfigFileWithMeta(
    params.rootDir,
    params.configPath ?? env.LLM_RUNTIME_CONFIG_FILE,
  );
  validateRuntimeWebUiConfig(source.config, source.path);
  const config = source.config;
  const webUi = isRecord(config.webUi) ? config.webUi : undefined;
  const enabled = webUi?.openOnRuntimeServiceStart === true;
  const address = resolveWebUiAddress(env);

  return {
    enabled,
    listenHost: address.listenHost,
    port: address.port,
    browserUrl: address.browserUrl,
    healthUrl: address.healthUrl,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function waitForWebUiReady(
  healthUrl: string,
  options: {
    fetch?: FetchLike;
    sleep?: (durationMs: number) => Promise<void>;
    timeoutMs?: number;
    intervalMs?: number;
    requestTimeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<ReadinessResult> {
  const fetchHealth = options.fetch ?? (fetch as FetchLike);
  const sleep =
    options.sleep ??
    ((durationMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  const intervalMs = Math.max(
    1,
    options.intervalMs ?? DEFAULT_READY_INTERVAL_MS,
  );
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastError = "Web UI did not become ready";

  while (attempts === 0 || now() < deadline) {
    attempts += 1;
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - now());
    const requestBudgetMs = Math.min(requestTimeoutMs, remainingMs);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const requestDeadline = new Promise<FetchResponse>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("health request timed out"));
      }, requestBudgetMs);
    });
    try {
      const response = await Promise.race([
        fetchHealth(healthUrl, { signal: controller.signal }),
        requestDeadline,
      ]);
      if (response.ok) {
        return { ready: true, attempts };
      }
      lastError = `health endpoint returned HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = errorMessage(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    const remainingAfterAttemptMs = deadline - now();
    if (remainingAfterAttemptMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingAfterAttemptMs));
  }

  return { ready: false, attempts, lastError };
}

export function resolveWslgBrowserEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  userId = process.getuid?.() ?? 1000,
): NodeJS.ProcessEnv {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || `/run/user/${userId}`;
  return {
    ...env,
    DISPLAY: env.DISPLAY?.trim() || ":0",
    WAYLAND_DISPLAY: env.WAYLAND_DISPLAY?.trim() || "wayland-0",
    XDG_RUNTIME_DIR: runtimeDir,
    PULSE_SERVER: env.PULSE_SERVER?.trim() || "unix:/mnt/wslg/PulseServer",
    DBUS_SESSION_BUS_ADDRESS:
      env.DBUS_SESSION_BUS_ADDRESS?.trim() ||
      `unix:path=${runtimeDir.replace(/\/$/, "")}/bus`,
  };
}

async function queueBrowserWithSystemd(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const forwardedEnvironment = [
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "PULSE_SERVER",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (env[key] ? [`--setenv=${key}=${env[key]}`] : []));
    const child = spawn(
      "/usr/bin/systemd-run",
      [
        "--user",
        "--collect",
        "--no-block",
        "--quiet",
        ...forwardedEnvironment,
        executable,
        ...args,
      ],
      {
        env,
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`systemd-run could not queue Chromium (exit ${exitCode})`),
      );
    });
  });
}

export async function openWebUiInWslg(
  url: string,
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    spawnBrowser?: SpawnBrowser;
    userId?: number;
  } = {},
): Promise<void> {
  const exists = options.exists ?? existsSync;
  if (!exists("/mnt/wslg")) {
    throw new Error("WSLg is unavailable at /mnt/wslg");
  }

  const candidates: readonly Readonly<{
    executable: string;
    args: readonly string[];
  }>[] = [
    { executable: "/snap/bin/chromium", args: ["--new-window", url] },
    { executable: "/usr/bin/chromium-browser", args: ["--new-window", url] },
    { executable: "/usr/bin/xdg-open", args: [url] },
  ];
  const selected = candidates.find((candidate) => exists(candidate.executable));
  if (!selected) {
    throw new Error("No supported WSLg Chromium/xdg-open launcher was found");
  }

  const spawnBrowser = options.spawnBrowser ?? queueBrowserWithSystemd;
  await spawnBrowser(
    selected.executable,
    selected.args,
    resolveWslgBrowserEnvironment(options.env, options.userId),
  );
}

export async function runRuntimeServiceWebUiAutoOpen(params: {
  settings: RuntimeServiceWebUiSettings;
  waitUntilReady?: typeof waitForWebUiReady;
  openBrowser?: (url: string) => Promise<void>;
}): Promise<AutoOpenResult> {
  if (!params.settings.enabled) {
    return { status: "disabled" };
  }

  const readiness = await (params.waitUntilReady ?? waitForWebUiReady)(
    params.settings.healthUrl,
  );
  if (!readiness.ready) {
    return {
      status: "not-ready",
      url: params.settings.browserUrl,
      attempts: readiness.attempts,
      error: readiness.lastError ?? "Web UI did not become ready",
    };
  }

  try {
    await (params.openBrowser ?? openWebUiInWslg)(params.settings.browserUrl);
    return {
      status: "opened",
      url: params.settings.browserUrl,
      attempts: readiness.attempts,
    };
  } catch (error: unknown) {
    return {
      status: "open-failed",
      url: params.settings.browserUrl,
      attempts: readiness.attempts,
      error: errorMessage(error),
    };
  }
}
