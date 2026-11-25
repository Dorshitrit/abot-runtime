import type { AgentWorkResult } from "./application-contracts.js";

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function measuredTokens(event: Record<string, unknown>): number | null {
  if (nonNegativeInteger(event.totalTokens)) return event.totalTokens;
  if (!nonNegativeInteger(event.inputTokens)) return null;
  if (!nonNegativeInteger(event.outputTokens)) return null;
  const total = event.inputTokens + event.outputTokens;
  return Number.isSafeInteger(total) ? total : null;
}

function observedInvocations(requestId: string, events: readonly Record<string, unknown>[]) {
  const admitted = new Set<string>();
  const measurements = new Map<string, number>();
  for (const event of events) {
    if (event.requestId !== requestId) continue;
    if (typeof event.invocationId !== "string" || !event.invocationId) continue;
    if (event.name === "context.window.snapshot" && event.admissionOutcome === "accepted") admitted.add(event.invocationId);
    if (event.name !== "context.window.provider_usage") continue;
    if (event.measurement !== "actual" || event.source !== "provider_reported") return null;
    const tokens = measuredTokens(event);
    if (tokens === null) return null;
    const previous = measurements.get(event.invocationId);
    if (previous !== undefined && previous !== tokens) return null;
    measurements.set(event.invocationId, tokens);
  }
  if (admitted.size === 0) return null;
  for (const id of measurements.keys()) if (!admitted.has(id)) return null;
  let totalTokens = 0;
  for (const tokens of measurements.values()) {
    totalTokens += tokens;
    if (!Number.isSafeInteger(totalTokens)) return null;
  }
  return { admitted, measurements, totalTokens };
}

/** Read existing request receipts only. Missing measurements never become zero final usage. */
export function ordinarySessionUsage(requestId: string, events: readonly Record<string, unknown>[]): AgentWorkResult["usage"] {
  const observed = observedInvocations(requestId, events);
  if (!observed || observed.admitted.size !== observed.measurements.size) return null;
  return { modelCalls: observed.admitted.size, totalTokens: observed.totalTokens };
}

/** Confirmed live lower bound. Unfinished calls count immediately; only reported tokens are included. */
export function ordinarySessionUsageLowerBound(requestId: string, events: readonly Record<string, unknown>[]): AgentWorkResult["usage"] {
  const observed = observedInvocations(requestId, events);
  if (!observed) return null;
  return { modelCalls: observed.admitted.size, totalTokens: observed.totalTokens };
}
