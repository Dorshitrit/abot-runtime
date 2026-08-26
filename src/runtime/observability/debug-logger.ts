import { join } from "node:path";

import { loadRuntimeConfig } from "../config.js";
import {
  DEFAULT_RUNTIME_LOGGING_ENABLED,
  DEFAULT_RUNTIME_LOG_ROTATION_CONFIG,
} from "../config/constants.js";
import { DEFAULT_RUNTIME_TRACE_FILE } from "../config/layout.js";
import type { RuntimeLogRotationConfig } from "../ports.js";
import {
  appendTraceLineWithRotation,
  type LogRotationWarning,
} from "./log-rotation.js";

type DebugEvent = {
  scope: string;
  event: string;
  ts: string;
  [key: string]: unknown;
};

const LEGACY_DEFAULT_LOG_PATH = join(process.cwd(), DEFAULT_RUNTIME_TRACE_FILE);

export type DebugLoggerConfig = {
  traceFile?: string;
  enabled?: boolean;
  rotation?: RuntimeLogRotationConfig;
};

function readTraceEnabledOverride(): boolean | undefined {
  const value = process.env.LLM_RUNTIME_TRACE?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  return !(value === "0" || value === "false" || value === "off");
}

function getDefaultLogPathCacheKey(): string {
  return JSON.stringify({
    cwd: process.cwd(),
    profile: process.env.LLM_RUNTIME_PROFILE ?? "",
    runtimeDir: process.env.LLM_RUNTIME_DIR ?? "",
    traceFile: process.env.LLM_RUNTIME_TRACE_FILE ?? "",
  });
}

function warnCleanupFailure(warning: LogRotationWarning): void {
  console.warn(
    JSON.stringify({
      scope: "runtime.debug-logger",
      event: warning.event,
      ts: new Date().toISOString(),
      traceFile: warning.traceFile,
      error: warning.error,
      paths: warning.paths,
    }),
  );
}

/** Owns the single process-wide trace configuration and serialized write queue. */
export class ProcessDebugLogger {
  private config: DebugLoggerConfig = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private cachedDefaultLogPath:
    | {
        key: string;
        path: string;
      }
    | undefined;

  configure(config: DebugLoggerConfig = {}): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  reset(): void {
    this.config = {};
    this.writeQueue = Promise.resolve();
    this.cachedDefaultLogPath = undefined;
  }

  trace(
    scope: string,
    event: string,
    data: Record<string, unknown> = {},
  ): void {
    if (!this.shouldTrace()) {
      return;
    }

    const payload: DebugEvent = {
      scope,
      event,
      ts: new Date().toISOString(),
      ...data,
    };

    const line = JSON.stringify(payload);
    console.log(line);
    void this.writeLine(line).catch((error) => {
      console.error(
        JSON.stringify({
          scope: "runtime.debug-logger",
          event: "write.failed",
          ts: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  /** Waits for every trace write queued before this call to settle. */
  async drain(): Promise<void> {
    await this.writeQueue;
  }

  private shouldTrace(): boolean {
    const envOverride = readTraceEnabledOverride();
    if (envOverride !== undefined) {
      return envOverride;
    }
    if (typeof this.config.enabled === "boolean") {
      return this.config.enabled;
    }
    return DEFAULT_RUNTIME_LOGGING_ENABLED;
  }

  private resolveDefaultLogPath(): string {
    const cacheKey = getDefaultLogPathCacheKey();
    if (this.cachedDefaultLogPath?.key === cacheKey) {
      return this.cachedDefaultLogPath.path;
    }

    let path = LEGACY_DEFAULT_LOG_PATH;
    try {
      path = loadRuntimeConfig({ rootDir: process.cwd() }).paths.traceFile;
    } catch {
      path = LEGACY_DEFAULT_LOG_PATH;
    }

    this.cachedDefaultLogPath = {
      key: cacheKey,
      path,
    };
    return path;
  }

  private getLogPath(): string {
    const envPath = process.env.LLM_RUNTIME_TRACE_FILE?.trim();
    return envPath || this.config.traceFile || this.resolveDefaultLogPath();
  }

  private getRotationConfig(): RuntimeLogRotationConfig {
    return this.config.rotation ?? DEFAULT_RUNTIME_LOG_ROTATION_CONFIG;
  }

  private async appendLogLine(line: string): Promise<void> {
    await appendTraceLineWithRotation({
      traceFile: this.getLogPath(),
      line,
      rotation: this.getRotationConfig(),
      onWarning: warnCleanupFailure,
    });
  }

  private async writeLine(line: string): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.appendLogLine(line));
    return this.writeQueue;
  }
}

export const processDebugLogger = new ProcessDebugLogger();

export function configureDebugLogger(config: DebugLoggerConfig = {}): void {
  processDebugLogger.configure(config);
}

export function resetDebugLoggerConfig(): void {
  processDebugLogger.reset();
}

export function traceDebug(
  scope: string,
  event: string,
  data: Record<string, unknown> = {},
): void {
  processDebugLogger.trace(scope, event, data);
}
