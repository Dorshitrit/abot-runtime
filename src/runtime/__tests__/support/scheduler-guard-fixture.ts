import { vi } from "vitest";
import type { SchedulerExecutor, SchedulerSnapshot, SchedulerStore } from "../../scheduler/contracts.js";
import { createSchedulerService } from "../../scheduler/scheduler-service.js";

export function schedulerGuardDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

export async function schedulerGuardFixture() {
  let snapshot: SchedulerSnapshot = { schemaVersion: 1, jobs: [], runs: [] };
  let beforeUpdate: (() => Promise<void>) | undefined;
  let afterClaim: (() => Promise<void>) | undefined;
  const store: SchedulerStore = {
    acquire: async () => async () => undefined,
    read: async () => structuredClone(snapshot),
    update: async (mutate) => {
      await beforeUpdate?.();
      const next = structuredClone(snapshot);
      const result = mutate(next);
      const newlyClaimed = next.runs.some((run) => run.status === "running" &&
        !snapshot.runs.some((previous) => previous.id === run.id && previous.status === "running"));
      snapshot = next;
      if (newlyClaimed) await afterClaim?.();
      return result;
    },
  };
  const sessionExists = vi.fn(async () => true);
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({ status: "succeeded" }));
  const service = createSchedulerService({
    environmentId: "test", store, tickIntervalMs: 1_000_000,
    now: () => Date.parse("2026-10-26T09:00:00Z"),
    executor: { sessionExists, tryReserve: () => () => undefined, start },
  });
  await service.start();
  const job = await service.create({
    sessionId: "session", title: "Original", prompt: "Original task", modelProfileId: "model",
    agentMode: "fast", toolPermissionMode: "full_plus", timeZone: "UTC",
    schedule: { kind: "interval", everyMs: 60_000 },
  });
  return {
    service, job, start, sessionExists,
    snapshot: () => structuredClone(snapshot),
    changeBeforeUpdate: (callback?: () => Promise<void>) => { beforeUpdate = callback; },
    holdClaim: (callback?: () => Promise<void>) => { afterClaim = callback; },
    replaceSnapshot: (next: SchedulerSnapshot) => { snapshot = structuredClone(next); },
  };
}
