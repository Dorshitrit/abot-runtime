export type CoWorkerResourceLimits = Readonly<{
  modelCallsPerDay: number;
  embeddingCallsPerDay: number;
  embeddingCharactersPerDay: number;
  maxConcurrentCalls: number;
  timeZone: string;
}>;

/** Embedding safety defaults are implementation limits, independently configurable. */
export const DEFAULT_CO_WORKER_RESOURCE_LIMITS: CoWorkerResourceLimits =
  Object.freeze({
    modelCallsPerDay: 24,
    embeddingCallsPerDay: 96,
    embeddingCharactersPerDay: 1_048_576,
    maxConcurrentCalls: 1,
    timeZone: "UTC",
  });

export type CoWorkerResourceUsage = Readonly<{
  schemaVersion: 1;
  timeZone: string;
  startedAt: number;
  resetsAt: number;
  modelCalls: number;
  embeddingCalls: number;
  embeddingCharacters: number;
}>;

export type CoWorkerResourceActivity = "processing" | "proactive";

export type CoWorkerResourceReservation = Readonly<{
  kind: "model" | "embedding";
  activity?: CoWorkerResourceActivity;
  /** Only known cloud providers may opt into parallel execution. */
  supportsParallel: boolean;
  embeddingCharacters?: number;
  signal: AbortSignal;
  assertActivityAllowed(): void;
}>;

export function validateCoWorkerResourceLimits(
  limits: CoWorkerResourceLimits,
): void {
  const counts = [
    limits.modelCallsPerDay,
    limits.embeddingCallsPerDay,
    limits.embeddingCharactersPerDay,
    limits.maxConcurrentCalls,
  ];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error("co_worker_resource_limits_invalid");
  if (limits.maxConcurrentCalls > 8)
    throw new Error("co_worker_resource_limits_invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: limits.timeZone }).format(0);
  } catch {
    throw new Error("co_worker_resource_time_zone_invalid");
  }
}
