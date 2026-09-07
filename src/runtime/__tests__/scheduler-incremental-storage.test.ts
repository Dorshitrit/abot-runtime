import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";

async function files(
  directory: string,
): Promise<Map<string, { hash: string; bytes: number }>> {
  const result = new Map<string, { hash: string; bytes: number }>();
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    result.set(path, {
      hash: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  return result;
}

test("one-second recurring transitions do not rewrite retained history payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-incremental-"));
  const store = createFileSchedulerStore(directory);
  let now = Date.parse("2026-09-06T08:00:00.000Z");
  const start = vi.fn(async () => ({
    status: "succeeded" as const,
    resultText: "new result",
  }));
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
  try {
    await service.start();
    const job = await service.create({
      sessionId: "session",
      title: "Every second",
      prompt: "new prompt",
      modelProfileId: "model",
      agentMode: "fast",
      timeZone: "UTC",
      schedule: { kind: "interval", everyMs: 1000 },
    });
    const history = Array.from({ length: 160 }, (_, index) => ({
      ...makeSchedulerRun(
        job,
        new Date(now - (index + 1) * 1000).toISOString(),
        "schedule",
      ),
      status: "succeeded" as const,
      prompt: `old prompt ${index}` + "p".repeat(8192),
      resultText: `old result ${index}` + "r".repeat(8192),
    }));
    await store.update((state) => {
      state.runs.push(...history);
    });
    const before = await files(directory);
    now += 1000;
    await service.tick();
    await vi.waitFor(async () => {
      const latest = await service.listRuns(job.id, { limit: 1 });
      expect(latest[0].resultText).toBe("new result");
    });
    const after = await files(directory);
    const changedBytes = [...after]
      .filter(([path, value]) => before.get(path)?.hash !== value.hash)
      .reduce((sum, [, value]) => sum + value.bytes, 0);
    expect(changedBytes).toBeLessThan(30_000);
    expect(start).toHaveBeenCalledOnce();
    expect((await service.listRuns(job.id)).slice(0, history.length)).toEqual(
      history,
    );
  } finally {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
