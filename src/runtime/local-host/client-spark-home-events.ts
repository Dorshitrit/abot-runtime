export type SparkHomeChanged = Readonly<{ runId: string; revision: number }>;

/** Invalidation identity only; run state and approvals must be fetched from their HOME owner. */
export function projectSparkHomeChange(value: unknown): SparkHomeChanged | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.runId !== "string" || !event.runId.trim() || event.runId.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(event.runId)) return undefined;
  if (!Number.isSafeInteger(event.revision) || Number(event.revision) < 1) return undefined;
  return Object.freeze({ runId: event.runId, revision: Number(event.revision) });
}

export function createLocalSparkHomeEvents() {
  const listeners = new Set<(change: SparkHomeChanged) => void>();
  return {
    subscribe(listener: (change: SparkHomeChanged) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receive(value: unknown) {
      if (!value || typeof value !== "object" || !("type" in value) || value.type !== "spark-home.changed") return;
      const change = projectSparkHomeChange(value);
      if (!change) return;
      for (const listener of listeners) {
        try { listener(change); } catch { /* A disconnected view cannot change committed HOME state. */ }
      }
    },
    close() { listeners.clear(); },
  };
}
