import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningBatch, LearningObservation } from "../passive-learning/contracts.js";
import { LearningActiveBatches } from "../passive-learning/active-batches.js";
import { prepareApplicationPendingBatch } from "../passive-learning/application-pending.js";
import { LearningJournal } from "../passive-learning/journal.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { readLearningBatchReceipt, reconcileLearningBatchReceipts } from "../passive-learning/batch-receipt.js";
import { LearningProcessingCycle } from "../passive-learning/processing-cycle.js";
import { LearningAnalysisClock } from "../passive-learning/analysis-clock.js";
import { ObservationQueue } from "../passive-learning/queue.js";

const now = Date.parse("2026-09-25T12:00:00Z");
const timestamp = new Date(now - 60_000).toISOString();
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function observation(id: string, app: string): LearningObservation {
  return { id, deviceId: "device", timestamp, sequence: 1, source: { app, windowId: app },
    kind: "view", extraction: "uia", coverage: "complete", content: `Content ${id}` };
}
const mixed: LearningBatch = { id: "original", generation: "current", createdAt: timestamp,
  status: "pending", recordIds: [], observations: [observation("a", "Editor"), observation("b", "PRIVATE")] };

async function fixture(batches: readonly LearningBatch[] = [mixed]) {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-pending-eligible-20260925");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "learning-app-pending-"));
  directories.push(directory);
  const preferences = { ...DEFAULT_LEARNING_PREFERENCES, processingExcludedApplications: ["private"] };
  const store = createLearningStateStore(directory);
  await store.write({ schemaVersion: 1, preferences, batches });
  const journal = new LearningJournal({ directory, now: () => now, preferences: () => preferences,
    changed: vi.fn(), failed: vi.fn() });
  await journal.load("current");
  const receipt = vi.fn(async (): Promise<unknown> => undefined);
  const memory = { learning: { receipt } } as unknown as LongTermMemoryService;
  let current = true;
  const options = { journal, active: new LearningActiveBatches(), memory,
    preferences: () => preferences, generation: () => current ? "current" : "new", canProcess: () => current };
  const prepare = () => prepareApplicationPendingBatch(options);
  return { directory, journal, store, receipt, memory, options, prepare, supersede: () => { current = false; } };
}

describe("application exclusions and durable pending identities", () => {
  it("persists a mixed split before returning allowed evidence and preserves the expiry", async () => {
    const f = await fixture();
    const ready = await f.prepare();
    expect(ready).toMatchObject({ id: mixed.id, createdAt: timestamp, observations: [mixed.observations[0]] });
    const saved = (await f.store.read()).batches;
    expect(saved).toHaveLength(2);
    expect(saved.every((batch) => batch.createdAt === timestamp && batch.status === "pending")).toBe(true);
    const blocked = saved.find((batch) => batch.id !== mixed.id)!;
    expect(blocked).toMatchObject({ observations: [mixed.observations[1]], reason: "learning_application_processing_excluded" });
    expect(saved.flatMap((batch) => batch.observations).map((item) => item.id).sort()).toEqual(["a", "b"]);
  });

  it("reconciles an existing canonical receipt instead of splitting or replaying committed evidence", async () => {
    const f = await fixture();
    f.receipt.mockResolvedValue({ batchId: mixed.id, createdAt: timestamp, recordIds: ["saved"], candidateIds: ["candidate"] });
    expect(await f.prepare()).toBeUndefined();
    expect((await f.store.read()).batches).toEqual([expect.objectContaining({ id: mixed.id, status: "saved",
      observations: mixed.observations, recordIds: ["saved"], candidateIds: ["candidate"] })]);
  });

  it("falls back to the legacy receipt without splitting committed observations", async () => {
    const f = await fixture();
    const legacy = vi.fn(async () => ({ batchId: mixed.id, createdAt: timestamp, recordIds: ["legacy-memory"] }));
    Object.assign(f.memory, { observationBatchReceipt: legacy });
    expect(await f.prepare()).toBeUndefined();
    expect(legacy).toHaveBeenCalledWith(mixed.id);
    expect(f.journal.items).toMatchObject([{ id: mixed.id, status: "saved", recordIds: ["legacy-memory"] }]);
  });

  it.each(["budget", "admission", "already-deferred", "blocked-only"])(
    "reconciles paid receipts before %s gates without dispatching model work", async (gate) => {
      const batch = gate === "blocked-only" ? { ...mixed, observations: [mixed.observations[1]!] } : mixed;
      const f = await fixture([batch]);
      f.receipt.mockResolvedValue({ batchId: mixed.id, createdAt: timestamp, recordIds: [], candidateIds: ["candidate"] });
      const resourceUsage = vi.fn(async () => ({ schemaVersion: 1 as const, timeZone: "UTC", startedAt: now,
        resetsAt: now + 86_400_000, modelCalls: 24, embeddingCalls: 0, embeddingCharacters: 0, activeCalls: 0 }));
      const admission = vi.fn(async () => ({ available: false, retryAt: null }));
      Object.assign(f.memory.learning!, { reviewAdmission: admission });
      const dispatch = vi.fn();
      const cycle = new LearningProcessingCycle({ ...f.options, queue: new ObservationQueue(),
        canReconcileReceipts: f.options.canProcess,
        background: { memory: f.memory, model: { validateProfile() {}, extract: vi.fn() }, resourceUsage },
        clock: new LearningAnalysisClock(vi.fn()), now: () => now, intervalMs: () => 60_000,
        concurrency: () => 1, dispatch, arm: vi.fn(), deferred: vi.fn() });
      if (gate === "already-deferred") cycle.deferral = { until: now + 86_400_000, reason: "co_worker_model_daily_budget_exhausted" };
      await cycle.flush();
      expect((await f.store.read()).batches).toMatchObject([{ id: mixed.id, status: "reviewed", candidateIds: ["candidate"] }]);
      expect(resourceUsage).not.toHaveBeenCalled(); expect(admission).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    });

  it.each(["current", "legacy"])("reconciles %s receipts on a fully blocked restart", async (namespace) => {
    const f = await fixture();
    const saved = await f.store.read();
    await f.store.write({ ...saved, preferences: { ...saved.preferences, processingPaused: false,
      processingExcludedApplications: ["Editor", "PRIVATE"] } });
    const committed = { batchId: mixed.id, createdAt: timestamp, recordIds: ["memory"] };
    if (namespace === "current") f.receipt.mockResolvedValue(committed);
    else Object.assign(f.memory, { observationBatchReceipt: vi.fn(async () => committed) });
    const reopened = new LearningJournal({ directory: f.directory, now: () => now, preferences: f.options.preferences,
      changed: vi.fn(), failed: vi.fn(), receipt: (id) => readLearningBatchReceipt(f.memory, id) });
    await reopened.load("restarted");
    expect(reopened.items).toMatchObject([{ id: mixed.id, status: "saved", recordIds: ["memory"] }]);
  });

  it("does not restore a deleted batch when a receipt arrives late", async () => {
    const f = await fixture();
    let release!: () => void;
    f.receipt.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({
      batchId: mixed.id, createdAt: timestamp, recordIds: ["saved"] }); }));
    const reconciling = reconcileLearningBatchReceipts(f.options);
    await vi.waitFor(() => expect(f.receipt).toHaveBeenCalledOnce());
    f.supersede(); await f.journal.clearPending(); release(); await reconciling;
    expect((await f.store.read()).batches).toEqual([]);
  });

  it("does not evict any pending work when a split cannot fit", async () => {
    const batches = [mixed, ...Array.from({ length: 49 }, (_, index) => ({ ...mixed, id: `held-${index}`,
      observations: [observation(`held-${index}`, "private")] }))];
    const f = await fixture(batches);
    const before = await f.store.read();
    await expect(f.prepare()).rejects.toThrow("learning_partition_capacity");
    expect(await f.store.read()).toEqual(before);
  });

  it("does not resurrect cleared work after an asynchronous receipt lookup", async () => {
    const f = await fixture();
    let release!: () => void;
    f.receipt.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(undefined); }));
    const preparing = f.prepare();
    await vi.waitFor(() => expect(f.receipt).toHaveBeenCalledOnce());
    f.supersede();
    await f.journal.clearPending();
    release();
    expect(await preparing).toBeUndefined();
    expect((await f.store.read()).batches).toEqual([]);
  });
});
