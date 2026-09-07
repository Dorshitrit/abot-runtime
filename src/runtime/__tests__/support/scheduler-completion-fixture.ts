import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type {
  SchedulerExecutor,
  SchedulerStore,
} from "../../scheduler/contracts.js";
import { createFileSchedulerStore } from "../../scheduler/file-store.js";
import { createSchedulerService } from "../../scheduler/scheduler-service.js";

export function deferredCompletion<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export async function schedulerCompletionFixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-scheduler-completion-"));
  const base = createFileSchedulerStore(directory);
  let now = Date.parse("2026-09-06T10:00:00Z");
  let nextUpdateBarrier: (() => Promise<void>) | undefined;
  const failingSessions = new Set<string>();
  const terminalAttempts = vi.fn();
  const store: SchedulerStore = {
    ...base,
    update: async (mutate) => {
      const barrier = nextUpdateBarrier;
      nextUpdateBarrier = undefined;
      await barrier?.();
      return base.update((state) => {
        const running = new Set(
          state.runs
            .filter((run) => run.status === "running")
            .map((run) => run.id),
        );
        const result = mutate(state);
        for (const run of state.runs) {
          if (!running.has(run.id)) continue;
          if (run.status !== "succeeded" && run.status !== "failed") continue;
          terminalAttempts(run.id);
          if (failingSessions.has(run.sessionId)) {
            throw new Error("terminal_write_failed");
          }
        }
        return result;
      });
    },
  };
  const reserved = new Set<string>();
  const release = vi.fn((sessionId: string) => {
    reserved.delete(sessionId);
  });
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
    resultText: "done",
  }));
  const onError = vi.fn();
  const service = createSchedulerService({
    environmentId: "test",
    store,
    executor: {
      sessionExists: async () => true,
      tryReserve: (sessionId) => {
        if (reserved.has(sessionId)) return null;
        reserved.add(sessionId);
        return () => release(sessionId);
      },
      start,
    },
    now: () => now,
    tickIntervalMs: 1_000_000,
    onError,
  });
  await service.start();
  return {
    service,
    store,
    start,
    release,
    onError,
    failingSessions,
    terminalAttempts,
    create: (sessionId = "session") =>
      service.create({
        sessionId,
        title: "Completion persistence",
        prompt: "Saved work",
        modelProfileId: "model",
        agentMode: "fast",
        timeZone: "UTC",
        schedule: { kind: "interval", everyMs: 60_000 },
      }),
    advance: (ms = 60_000) => {
      now += ms;
    },
    holdNextUpdate: () => {
      const entered = deferredCompletion<void>();
      const resume = deferredCompletion<void>();
      nextUpdateBarrier = async () => {
        entered.resolve();
        await resume.promise;
      };
      return { entered: entered.promise, resume: () => resume.resolve() };
    },
    dispose: async () => {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
