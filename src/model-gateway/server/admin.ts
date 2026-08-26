import type { IncomingMessage } from "node:http";

import type {
  ModelGatewayHandlerOptions,
  ModelGatewayRestartRequest,
  ModelGatewayRestartResult,
  ModelGatewayStatusResult,
} from "./contracts.js";

const STARTED_AT = new Date(Date.now() - process.uptime() * 1000);
const DEFAULT_RESTART_DELAY_MS = 250;
const MAX_RESTART_DELAY_MS = 30_000;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function readNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return Number.NaN;
}

function readPositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const numeric = readNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(numeric), max);
}

function readRestartReason(
  params: Record<string, unknown>,
): string | undefined {
  if (typeof params.reason !== "string") {
    return undefined;
  }
  const reason = params.reason.trim();
  return reason.length > 0 ? reason : undefined;
}

function defaultRestartHandler(): void {
  process.exit(0);
}

export function isLoopbackRequest(request: IncomingMessage): boolean {
  const remoteAddress = request.socket.remoteAddress;
  return remoteAddress !== undefined && LOOPBACK_ADDRESSES.has(remoteAddress);
}

export function requestModelGatewayRestart(
  params: Record<string, unknown>,
  restartHandler: ModelGatewayHandlerOptions["restartHandler"] = defaultRestartHandler,
): ModelGatewayRestartResult {
  const reason = readRestartReason(params);
  const delayMs = readPositiveInt(
    params.delayMs,
    DEFAULT_RESTART_DELAY_MS,
    MAX_RESTART_DELAY_MS,
  );
  const request: ModelGatewayRestartRequest = {
    ...(reason ? { reason } : {}),
    delayMs,
  };
  const timer = setTimeout(() => {
    void Promise.resolve(restartHandler(request)).catch(() => {
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
    strategy: "process-exit",
  };
}

export function getModelGatewayStatus(): ModelGatewayStatusResult {
  return {
    pid: process.pid,
    uptimeMs: Math.floor(process.uptime() * 1000),
    startedAt: STARTED_AT.toISOString(),
    now: new Date().toISOString(),
  };
}
