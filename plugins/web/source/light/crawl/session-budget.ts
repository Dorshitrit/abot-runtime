import { WebPluginError } from "../../errors.js";
import type { LightConfig } from "../config.js";

export type LightStopReason = "time_budget" | "request_budget" | "byte_budget";
export type LightCrawlSnapshot = Readonly<{
  requests: number;
  bytes: number;
  decodedBytes: number;
  stopReason?: LightStopReason;
}>;

export function createSessionBudget(
  config: LightConfig,
  externalSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const hardDeadline = startedAt + config.hardTimeoutMs;
  let requests = 0;
  let bytes = 0;
  let reservedBytes = 0;
  let decodedBytes = 0;
  let stopReason: LightStopReason | undefined;
  let hardExpired = false;
  const onAbort = () => controller.abort();
  const hasReachedSoftDeadline = () =>
    Date.now() >= startedAt + config.softTimeoutMs;
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    hardExpired = true;
    stopReason ??= "time_budget";
    controller.abort();
  }, config.hardTimeoutMs);
  timer.unref?.();

  const assertActive = () => {
    if (externalSignal?.aborted) {
      throw new WebPluginError(
        "web_request_aborted",
        "The web request was aborted.",
      );
    }
    if (hardExpired || Date.now() >= hardDeadline) {
      stopReason ??= "time_budget";
      throw new WebPluginError(
        "web_request_timed_out",
        "The Light search exceeded its total time limit.",
      );
    }
    if (controller.signal.aborted) {
      throw new WebPluginError(
        "web_request_aborted",
        "The Light search session is closed.",
      );
    }
  };

  const exhaust = (reason: LightStopReason): never => {
    stopReason ??= reason;
    throw new WebPluginError(
      "web_search_budget_exhausted",
      "The Light search reached its bounded crawl budget.",
    );
  };

  return Object.freeze({
    signal: controller.signal,
    hardDeadline,
    assertActive,
    canContinue() {
      if (controller.signal.aborted) return false;
      if (stopReason !== undefined) return false;
      if (hasReachedSoftDeadline()) {
        stopReason ??= "time_budget";
        return false;
      }
      if (requests >= config.maxRequests) {
        stopReason ??= "request_budget";
        return false;
      }
      if (
        bytes >= config.maxTotalBytes ||
        decodedBytes >= config.maxTotalBytes
      ) {
        stopReason ??= "byte_budget";
        return false;
      }
      return true;
    },
    reserveRequest() {
      assertActive();
      if (hasReachedSoftDeadline()) return exhaust("time_budget");
      if (stopReason === "request_budget") return exhaust(stopReason);
      if (stopReason === "byte_budget") return exhaust(stopReason);
      if (requests >= config.maxRequests) return exhaust("request_budget");
      if (
        bytes + reservedBytes >= config.maxTotalBytes ||
        decodedBytes >= config.maxTotalBytes
      ) {
        return exhaust("byte_budget");
      }
      requests += 1;
      const reservation = Math.min(
        config.maxResponseBytes,
        config.maxTotalBytes - bytes - reservedBytes,
      );
      reservedBytes += reservation;
      return reservation;
    },
    completeRequest(count: number, reservation: number) {
      reservedBytes -= reservation;
      bytes += count;
      if (bytes > config.maxTotalBytes) exhaust("byte_budget");
    },
    consumeDecodedBytes(count: number) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError(
          "Decoded byte count must be a non-negative safe integer.",
        );
      }
      if (decodedBytes + count > config.maxTotalBytes) exhaust("byte_budget");
      decodedBytes += count;
    },
    snapshot(): LightCrawlSnapshot {
      return Object.freeze({
        requests,
        bytes,
        decodedBytes,
        ...(stopReason ? { stopReason } : {}),
      });
    },
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
      controller.abort();
    },
  });
}

export type LightSessionBudget = ReturnType<typeof createSessionBudget>;
