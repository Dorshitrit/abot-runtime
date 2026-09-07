import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { journalTransactionName } from "../scheduler/journal-files.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";

test("model inspection loads only the recent owned run payloads and preserves history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schedule-tool-history-"));
  const now = Date.parse("2026-09-06T08:00:00.000Z");
  const store = createFileSchedulerStore(directory);
  const start = vi.fn();
  const service = createSchedulerService({
    environmentId: "test",
    store,
    now: () => now,
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => () => {},
      start,
    },
  });
  const module = createSchedulingToolModule(
    service,
    {} as RuntimeConfig,
    async () => {},
  );
  const context = { sharedState: { currentSessionId: "session" } };
  let hidden: string | undefined;
  try {
    await service.start();
    const job = await service.create({
      sessionId: "session",
      title: "Summary",
      prompt: "Future task",
      modelProfileId: "model",
      agentMode: "fast",
      timeZone: "UTC",
      schedule: { kind: "daily", at: "09:00" },
    });
    const empty = await module.implementation(
      { action: "get", jobId: job.id },
      context,
    );
    expect(JSON.parse(empty.output)).toEqual({ job, runs: [] });
    const history = Array.from({ length: 60 }, (_, index) => ({
      ...makeSchedulerRun(
        job,
        new Date(now - 60_000 + index * 1000).toISOString(),
        "schedule",
      ),
      status: "succeeded" as const,
      prompt: `Historical task ${index}` + "p".repeat(8192),
      resultText: `Historical result ${index}` + "r".repeat(8192),
    }));
    await store.update((state) => {
      state.runs.push(...history.slice(0, 40));
    });
    const manifest = JSON.parse(
      await readFile(join(directory, "scheduler-journal.json"), "utf8"),
    );
    const generation = join(directory, manifest.generation);
    const oldFile = join(generation, journalTransactionName(manifest.sequence));
    await store.update((state) => {
      state.runs.push(...history.slice(40));
    });
    // The owner already indexed the old payloads. Inspecting the latest page must
    // not read this older transaction at all; a full-history read still needs it.
    await rename(oldFile, oldFile + ".held");
    hidden = oldFile;
    await expect(service.listRuns(job.id)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const foreign = await module.implementation(
      { action: "get", jobId: job.id },
      { sharedState: { currentSessionId: "another-session" } },
    );
    expect(foreign).toMatchObject({
      ok: false,
      error: "schedule_job_not_found",
    });
    const result = await module.implementation(
      { action: "get", jobId: job.id },
      context,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ job, runs: history.slice(40) });
    expect(result.data?.mutationEvidence).toBe(false);
    expect(start).not.toHaveBeenCalled();
    await rename(oldFile + ".held", oldFile);
    hidden = undefined;
    expect(await service.listRuns(job.id)).toEqual(history);
  } finally {
    if (hidden) await rename(hidden + ".held", hidden);
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
