import { readAgentAssociations } from "../../runtime/agents/session-association.js";

/** Presentation-only filter. Every Agent association/claim precedes runtime dispatch. */
export function createOrdinaryChatEventPublisher(input: {
  runtimeDir(environmentId: string): string;
  publish(event: Record<string, unknown>): void;
  unavailable?(environmentId: string): void;
}) {
  const classifications = new Map<string, Promise<boolean>>();
  const queues = new Map<string, Promise<void>>();
  let stopped = false;
  const flush = async () => { await Promise.all([...queues.values()]); };
  async function ordinary(event: Record<string, unknown>, environmentId: string): Promise<boolean> {
    const requestId = typeof event.requestId === "string" ? event.requestId : "";
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    if (!requestId && !sessionId) return true;
    const runtimeDir = input.runtimeDir(environmentId);
    // A request's immutable ownership is safe to cache; session-only events are rechecked.
    const key = requestId ? JSON.stringify([runtimeDir, environmentId, requestId, sessionId]) : null;
    let classification = key ? classifications.get(key) : undefined;
    if (!classification) {
      classification = readAgentAssociations(runtimeDir).then((index) => !index.requestIds.has(requestId) && !index.sessionIds.has(sessionId));
      if (key) {
        classifications.set(key, classification);
        if (classifications.size > 4096) classifications.delete(classifications.keys().next().value!);
        void classification.catch(() => { if (classifications.get(key) === classification) classifications.delete(key); });
      }
    }
    return classification;
  }
  return {
    publish(event: Record<string, unknown>, environmentId: string): void {
      if (stopped) return;
      const next = (queues.get(environmentId) ?? Promise.resolve()).then(async () => {
        if (await ordinary(event, environmentId)) input.publish(event);
      }).catch(() => { input.unavailable?.(environmentId); });
      queues.set(environmentId, next);
      void next.finally(() => { if (queues.get(environmentId) === next) queues.delete(environmentId); });
    },
    flush,
    stop() { stopped = true; return flush(); },
  };
}
