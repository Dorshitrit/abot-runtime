import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type {
  SchedulerExecutor,
  SchedulerStore,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";

test.each(["paused", "completed"] as const)(
  "repeated explicit session deletion removes %s scheduler Jobs and history after a cleanup write fails",
  async (jobState) => {
    const directory = await mkdtemp(
      join(tmpdir(), "scheduler-delete-cleanup-"),
    );
    const lifetime = createSessionLifecycleStore(createInMemorySessionStore());
    const base = createFileSchedulerStore(directory);
    let failNextWrite = false;
    const store: SchedulerStore = {
      ...base,
      update: async (mutate) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("scheduler_cleanup_write_failed");
        }
        return base.update(mutate);
      },
    };
    let now = Date.parse("2026-09-06T10:00:00Z");
    const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
      status: "succeeded",
    }));
    const scheduler = createSchedulerService({
      environmentId: "test",
      store,
      now: () => now,
      tickIntervalMs: 1_000_000,
      executor: {
        sessionExists: async (sessionId) => !lifetime.isDeleted(sessionId),
        tryReserve: (sessionId) =>
          lifetime.isDeleted(sessionId) ? null : () => undefined,
        start,
      },
    });
    lifetime.onDeleted((sessionId) => scheduler.deleteSession(sessionId));
    try {
      await scheduler.start();
      await lifetime.store.getOrCreateSession("session");
      const job = await scheduler.create({
        sessionId: "session",
        title: "Saved work",
        prompt: "Do work",
        modelProfileId: "model",
        agentMode: "fast",
        timeZone: "UTC",
        schedule: { kind: "timer", delayMs: 1_000 },
      });
      now += 1_000;
      await scheduler.tick();
      await vi.waitFor(async () =>
        expect((await scheduler.listRuns(job.id))[0].status).toBe("succeeded"),
      );
      if (jobState === "paused") await scheduler.pause(job.id);
      expect((await scheduler.get(job.id))?.state).toBe(jobState);
      failNextWrite = true;
      await expect(lifetime.store.deleteSession("session")).rejects.toThrow(
        "scheduler_cleanup_write_failed",
      );
      expect(await lifetime.store.getSessionById("session")).toBeNull();
      expect((await scheduler.get(job.id))?.state).toBe(jobState);
      expect(await scheduler.listRuns(job.id)).toHaveLength(1);
      await expect(scheduler.runNow(job.id)).rejects.toThrow(
        "scheduler_session_deleted",
      );
      await expect(
        lifetime.store.appendMessage("session", "assistant", "late"),
      ).rejects.toMatchObject({ code: "session_deleted" });

      await expect(
        lifetime.store.deleteSessionWithStats("session"),
      ).resolves.toMatchObject({ deleted: true });
      expect(await scheduler.get(job.id)).toBeNull();
      expect(await scheduler.listRuns(job.id)).toEqual([]);
      now += 60_000;
      await scheduler.tick();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      await scheduler.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
