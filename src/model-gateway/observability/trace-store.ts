import {
  DEFAULT_RUNTIME_LOGGING_ENABLED,
  DEFAULT_RUNTIME_LOG_ROTATION_CONFIG,
} from "../../runtime/config/constants.js";
import type { RuntimeLogRotationConfig } from "../../runtime/ports.js";
import {
  appendTraceLineWithRotation,
  type LogRotationWarning,
} from "../../runtime/observability/log-rotation.js";

export type ModelIoTraceConfig = {
  traceFile?: string;
  enabled?: boolean;
  rotation?: RuntimeLogRotationConfig;
};

export type ModelIoTraceEvent = {
  event: "provider.request" | "provider.response" | "provider.failure";
  invocationId: string;
  requestId: string;
  endpoint: "chat" | "raw";
  modelStep: string;
  profileId: string;
  providerId: string;
  provider: string;
  model: string;
  [key: string]: unknown;
};

function warnCleanupFailure(warning: LogRotationWarning): void {
  console.warn(
    JSON.stringify({
      scope: "model-gateway.model-io-trace",
      event: warning.event,
      ts: new Date().toISOString(),
      traceFile: warning.traceFile,
      error: warning.error,
      paths: warning.paths,
    }),
  );
}

function reportWriteFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      scope: "model-gateway.model-io-trace",
      event: "write.failed",
      ts: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Owns the gateway process trace configuration and serialized write queue. */
export class ProcessModelIoTrace {
  private config: ModelIoTraceConfig = {};
  private writeQueue: Promise<void> = Promise.resolve();

  configure(config: ModelIoTraceConfig = {}): void {
    this.config = { ...this.config, ...config };
  }

  reset(): void {
    this.config = {};
    this.writeQueue = Promise.resolve();
  }

  isEnabled(): boolean {
    const enabled = this.config.enabled ?? DEFAULT_RUNTIME_LOGGING_ENABLED;
    return enabled && Boolean(this.config.traceFile);
  }

  async trace(event: ModelIoTraceEvent): Promise<void> {
    const traceFile = this.config.traceFile;
    if (!this.isEnabled() || !traceFile) {
      return;
    }

    const line = JSON.stringify({
      version: 1,
      ts: new Date().toISOString(),
      ...event,
    });
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() =>
        appendTraceLineWithRotation({
          traceFile,
          line,
          rotation: this.config.rotation ?? DEFAULT_RUNTIME_LOG_ROTATION_CONFIG,
          onWarning: warnCleanupFailure,
        }),
      );

    try {
      await this.writeQueue;
    } catch (error) {
      reportWriteFailure(error);
    }
  }
}

export const processModelIoTrace = new ProcessModelIoTrace();

export function configureModelIoTrace(config: ModelIoTraceConfig = {}): void {
  processModelIoTrace.configure(config);
}

export function resetModelIoTraceConfig(): void {
  processModelIoTrace.reset();
}

export function isModelIoTraceEnabled(): boolean {
  return processModelIoTrace.isEnabled();
}

export async function traceModelIo(event: ModelIoTraceEvent): Promise<void> {
  return processModelIoTrace.trace(event);
}
