import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { loadRuntimeConfig } from "../config.js";
import type { RuntimeConfig } from "../ports.js";
import { getRuntimeConfig } from "./config-control.js";

export type RuntimeStatusResult = {
  pid: number;
  uptimeMs: number;
  startedAt: string;
  now: string;
  cwd: string;
  node: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  memory: NodeJS.MemoryUsage;
  config: {
    rootDir: string;
    configPath: string;
    configExists: boolean;
    traceFile: string;
  };
  restart: {
    supported: boolean;
    strategy: "systemctl-user";
  };
};

export type RuntimeLogTailResult = {
  path: string;
  exists: boolean;
  sizeBytes: number;
  maxBytes: number;
  lineCount: number;
  lines: string[];
  entries: unknown[];
};

export type RuntimeRestartRequest = {
  reason?: string;
  delayMs: number;
};

export type RuntimeRestartResult = {
  accepted: true;
  pid: number;
  reason?: string;
  delayMs: number;
  scheduledAt: string;
  strategy: "systemctl-user";
  modelGateway?: {
    scheduled: boolean;
    url: string;
  };
};

export type RuntimeRestartHandler = (
  request: RuntimeRestartRequest,
) => void | Promise<void>;

export type RuntimeManagedServiceId =
  | "runtime_prod"
  | "runtime_dev"
  | "model_gateway";

export type RuntimeManagedServiceRestartRequest = {
  serviceId: RuntimeManagedServiceId;
  unit: string;
  delayMs: number;
};

export type RuntimeManagedServiceRestartResult = {
  accepted: true;
  serviceId: RuntimeManagedServiceId;
  unit: string;
  label: string;
  delayMs: number;
  scheduledAt: string;
  strategy: "systemctl-user";
};

export type RuntimeManagedServiceRestartHandler = (
  request: RuntimeManagedServiceRestartRequest,
) => void | Promise<void>;

export type RuntimeModelGatewayRestartOptions = {
  url?: string;
  fetchImpl?: typeof fetch;
};

const execFileAsync = promisify(execFile);
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000);
const DEFAULT_LOG_LINES = 200;
const DEFAULT_LOG_MAX_BYTES = 64 * 1024;
const MAX_LOG_LINES = 1000;
const MAX_LOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_RESTART_DELAY_MS = 250;
const MAX_RESTART_DELAY_MS = 30_000;
const MANAGED_SERVICE_RESTART_UNITS = [
  "model-gateway.service",
  "abot.service",
  "abot-dev.service",
];
const MANAGED_SERVICES: Record<
  RuntimeManagedServiceId,
  { unit: string; label: string }
> = {
  runtime_prod: {
    unit: "llm-runtime.service",
    label: "PROD runtime",
  },
  runtime_dev: {
    unit: "llm-runtime-dev.service",
    label: "DEV runtime",
  },
  model_gateway: {
    unit: "model-gateway.service",
    label: "Model gateway",
  },
};

function runtimeConfigFromOptions(params: {
  rootDir?: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
}): RuntimeConfig {
  return loadRuntimeConfig({
    rootDir: params.rootDir,
    configPath: params.configPath,
    env: params.env,
  });
}

function readPositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(numeric), max);
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return { raw: line };
  }
}

async function readTailBytes(
  path: string,
  maxBytes: number,
): Promise<{
  sizeBytes: number;
  text: string;
}> {
  const fileStat = await stat(path);
  const sizeBytes = fileStat.size;
  const length = Math.min(sizeBytes, maxBytes);
  if (length <= 0) {
    return { sizeBytes, text: "" };
  }

  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, sizeBytes - length);
    return {
      sizeBytes,
      text: buffer.toString("utf-8"),
    };
  } finally {
    await file.close();
  }
}

async function restartManagedServiceUnits(units: string[]): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    (uid !== null ? `/run/user/${uid}` : undefined);
  const busAddress =
    process.env.DBUS_SESSION_BUS_ADDRESS ??
    (runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined);

  await execFileAsync("systemctl", ["--user", "restart", ...units], {
    timeout: 20_000,
    env: {
      ...process.env,
      ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
      ...(busAddress ? { DBUS_SESSION_BUS_ADDRESS: busAddress } : {}),
    },
  });
}

function defaultRestartHandler(): Promise<void> {
  return restartManagedServiceUnits(MANAGED_SERVICE_RESTART_UNITS);
}

function defaultManagedServiceRestartHandler(
  request: RuntimeManagedServiceRestartRequest,
): Promise<void> {
  return restartManagedServiceUnits([request.unit]);
}

function resolveManagedServiceId(value: unknown): RuntimeManagedServiceId {
  if (typeof value !== "string") {
    throw new Error("invalid_service_id");
  }
  const serviceId = value.trim() as RuntimeManagedServiceId;
  if (!(serviceId in MANAGED_SERVICES)) {
    throw new Error("invalid_service_id");
  }
  return serviceId;
}

export function getRuntimeStatus(
  params: {
    rootDir?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeStatusResult {
  const config = runtimeConfigFromOptions(params);
  const metadata = getRuntimeConfig(params).metadata;
  return {
    pid: process.pid,
    uptimeMs: Math.floor(process.uptime() * 1000),
    startedAt: STARTED_AT.toISOString(),
    now: new Date().toISOString(),
    cwd: process.cwd(),
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    memory: process.memoryUsage(),
    config: {
      rootDir: metadata.rootDir,
      configPath: metadata.configPath,
      configExists: metadata.exists,
      traceFile: config.paths.traceFile,
    },
    restart: {
      supported: true,
      strategy: "systemctl-user",
    },
  };
}

export async function tailRuntimeLog(
  params: {
    rootDir?: string;
    configPath?: string;
    env?: Record<string, string | undefined>;
    lines?: unknown;
    maxBytes?: unknown;
  } = {},
): Promise<RuntimeLogTailResult> {
  const config = runtimeConfigFromOptions(params);
  const linesLimit = readPositiveInt(
    params.lines,
    DEFAULT_LOG_LINES,
    MAX_LOG_LINES,
  );
  const maxBytes = readPositiveInt(
    params.maxBytes,
    DEFAULT_LOG_MAX_BYTES,
    MAX_LOG_MAX_BYTES,
  );

  try {
    const tail = await readTailBytes(config.paths.traceFile, maxBytes);
    const lines = tail.text.split(/\r?\n/).filter(Boolean).slice(-linesLimit);
    return {
      path: config.paths.traceFile,
      exists: true,
      sizeBytes: tail.sizeBytes,
      maxBytes,
      lineCount: lines.length,
      lines,
      entries: lines.map(parseJsonLine),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {
        path: config.paths.traceFile,
        exists: false,
        sizeBytes: 0,
        maxBytes,
        lineCount: 0,
        lines: [],
        entries: [],
      };
    }
    throw error;
  }
}

export function requestRuntimeRestart(
  params: {
    reason?: unknown;
    delayMs?: unknown;
  } = {},
  restartHandler: RuntimeRestartHandler = defaultRestartHandler,
  modelGatewayRestart: RuntimeModelGatewayRestartOptions = {},
): RuntimeRestartResult {
  const reason =
    typeof params.reason === "string" && params.reason.trim()
      ? params.reason.trim()
      : undefined;
  const delayMs = readPositiveInt(
    params.delayMs,
    DEFAULT_RESTART_DELAY_MS,
    MAX_RESTART_DELAY_MS,
  );
  const request: RuntimeRestartRequest = {
    ...(reason ? { reason } : {}),
    delayMs,
  };
  void modelGatewayRestart;
  const timer = setTimeout(() => {
    const restart = async () => {
      await restartHandler(request);
    };
    void restart().catch(() => {
      process.exit(1);
    });
  }, delayMs);
  timer.unref?.();

  return {
    accepted: true,
    pid: process.pid,
    ...(reason ? { reason } : {}),
    delayMs,
    scheduledAt: new Date().toISOString(),
    strategy: "systemctl-user",
  };
}

export function requestRuntimeManagedServiceRestart(
  params: {
    serviceId?: unknown;
    delayMs?: unknown;
  } = {},
  restartHandler: RuntimeManagedServiceRestartHandler = defaultManagedServiceRestartHandler,
): RuntimeManagedServiceRestartResult {
  const serviceId = resolveManagedServiceId(params.serviceId);
  const service = MANAGED_SERVICES[serviceId];
  const delayMs = readPositiveInt(
    params.delayMs,
    DEFAULT_RESTART_DELAY_MS,
    MAX_RESTART_DELAY_MS,
  );
  const request: RuntimeManagedServiceRestartRequest = {
    serviceId,
    unit: service.unit,
    delayMs,
  };
  const timer = setTimeout(() => {
    const restart = async () => {
      await restartHandler(request);
    };
    void restart().catch(() => {
      process.exit(1);
    });
  }, delayMs);
  timer.unref?.();

  return {
    accepted: true,
    serviceId,
    unit: service.unit,
    label: service.label,
    delayMs,
    scheduledAt: new Date().toISOString(),
    strategy: "systemctl-user",
  };
}
