import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningBatch, PassiveLearningModel } from "../passive-learning/contracts.js";
import { LearningJournal } from "../passive-learning/journal.js";
import { processLearningBatch } from "../passive-learning/process-batch.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { createReassessmentStateStore } from "../passive-learning/reassessment-state.js";
import type { CoWorkerReviewProgress } from "../passive-learning/review-progress.js";
import { summarizeBatch } from "../passive-learning/status-projection.js";
import { prepareApplicationPendingBatch } from "../passive-learning/application-pending.js";
import { LearningActiveBatches } from "../passive-learning/active-batches.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function progress(stage = "identify"): CoWorkerReviewProgress {
  return { schemaVersion: 1, method: "super-v2", binding: "a".repeat(64),
    referenceTime: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString(),
    stages: [{ key: stage, fingerprint: "b".repeat(64), acceptedAt: new Date(NOW).toISOString(), response: '{"topics":[]}' }] };
}
function batch(id = "batch"): LearningBatch {
  return { id, generation: "generation", status: "pending", createdAt: new Date(NOW).toISOString(), recordIds: [],
    observations: [{ id: `${id}-observation`, deviceId: "computer", sequence: 1, timestamp: new Date(NOW).toISOString(),
      source: { app: "editor", windowId: "one" }, content: "Current activity", kind: "view", extraction: "uia", coverage: "complete" }] };
}
async function fixture() {
  const root = join(process.cwd(), ".codex/artifacts/co-worker-staged-reviews-20260927/progress-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "fixture-")); directories.push(directory);
  const journal = new LearningJournal({ directory, now: () => NOW, preferences: () => DEFAULT_LEARNING_PREFERENCES,
    changed: vi.fn(), failed: vi.fn() });
  await journal.load();
  const store = createLearningStateStore(directory);
  const reopen = async (receipt?: LongTermMemoryService["observationBatchReceipt"]) => {
    const restarted = new LearningJournal({ directory, now: () => NOW, preferences: () => DEFAULT_LEARNING_PREFERENCES,
      changed: vi.fn(), failed: vi.fn(), receipt });
    await restarted.load("restarted"); return restarted;
  };
  return { directory, journal, store, reopen };
}
function processor(journal: LearningJournal, current: LearningBatch, review: NonNullable<PassiveLearningModel["review"]>) {
  const apply = vi.fn(async () => ({ batchId: current.id, recordIds: [], candidateIds: [], createdAt: new Date(NOW).toISOString() }));
  const memory = { learning: { receipt: async () => undefined, reviewAdmission: async () => ({ available: true }),
    prepare: async () => ({ entries: [], omitted: 0 }), policy: async () => ({ promotionScore: 80 }), apply } } as unknown as LongTermMemoryService;
  const failed = vi.fn();
  return { apply, failed, options: { batch: current, signal: new AbortController().signal,
    modelProfileId: "local", model: { review, validateProfile() {}, extract: async () => [] }, memory,
    ownerId: "dev", isCurrent: () => true, timestamp: () => new Date(NOW).toISOString(),
    replace: (next: LearningBatch) => journal.replace(next), failed } };
}

describe("learning checkpoints in the existing journal", () => {
  test("loads old state and resumes accepted progress after a budget stop and restart", async () => {
    const f = await fixture(); await f.journal.replace(batch());
    expect((await f.store.read()).batches[0]!.reviewProgress).toBeUndefined();
    const first = processor(f.journal, f.journal.items[0]!, async (input) => {
      await input.progress!.save(progress());
      throw new Error("co_worker_model_daily_budget_exhausted");
    });
    await processLearningBatch(first.options);
    expect(first.apply).not.toHaveBeenCalled();
    expect(f.journal.items[0]).toMatchObject({ status: "pending", reviewProgress: progress() });
    expect(summarizeBatch(f.journal.items[0]!)).not.toHaveProperty("reviewProgress");
    const reopened = await f.reopen();
    const second = processor(reopened, reopened.items[0]!, async (input) => {
      expect(input.progress!.read()).toEqual(progress());
      expect(input.expiresAt).toBe(progress().expiresAt);
      return [];
    });
    await processLearningBatch(second.options);
    expect(second.apply).toHaveBeenCalledOnce();
    expect((await f.store.read()).batches[0]).toMatchObject({ status: "discarded" });
    expect((await f.store.read()).batches[0]!.reviewProgress).toBeUndefined();
  });

  test("a failed stage save stops work and preserves only previously accepted progress", async () => {
    const f = await fixture(); const original = { ...batch(), reviewProgress: progress() };
    await f.journal.replace(original);
    const continued = vi.fn();
    const run = processor(f.journal, original, async (input) => {
      await input.progress!.save(progress("score")); continued(); return [];
    });
    await processLearningBatch({ ...run.options, replace: async (next) => {
      if (next.reviewProgress?.stages[0]?.key === "score") throw new Error("disk unavailable");
      await f.journal.replace(next);
    } });
    expect(continued).not.toHaveBeenCalled(); expect(run.apply).not.toHaveBeenCalled();
    expect((await f.store.read()).batches[0]).toMatchObject({ status: "pending", reviewProgress: progress() });
  });

  test.each(["learning_processing_paused", "learning_stopped"])("retains progress after %s", async (reason) => {
    const f = await fixture(); const controller = new AbortController();
    const run = processor(f.journal, batch(), async (input) => {
      await input.progress!.save(progress()); controller.abort(new Error(reason)); input.signal.throwIfAborted(); return [];
    });
    await processLearningBatch({ ...run.options, signal: controller.signal });
    expect(f.journal.items[0]).toMatchObject({ status: "pending", reviewProgress: progress() });
    expect(run.apply).not.toHaveBeenCalled();
  });

  test("cannot evict another pending batch to save a checkpoint", async () => {
    const f = await fixture(); const current = batch();
    const other = batch("other");
    const fixedSize = Buffer.byteLength(JSON.stringify(current)) + Buffer.byteLength(JSON.stringify(other));
    const large = { ...other, observations: [{ ...other.observations[0]!, content: "x".repeat(4 * 1024 * 1024 - fixedSize - 32) }] };
    await f.journal.replaceMany([current, large]);
    const before = await f.store.read();
    await expect(f.journal.replace({ ...current, reviewProgress: progress() })).rejects.toThrow("learning_review_progress_capacity");
    expect(await f.store.read()).toEqual(before); expect(f.journal.items).toEqual(before.batches);
  });

  test("clears checkpoints when application filtering changes a batch and when pending work is deleted", async () => {
    const f = await fixture(); const current = batch();
    await f.journal.replace({ ...current, reviewProgress: progress(), observations: [current.observations[0]!,
      { ...current.observations[0]!, id: "excluded", source: { app: "browser", windowId: "two" } }] });
    const ready = await prepareApplicationPendingBatch({ journal: f.journal, active: new LearningActiveBatches(),
      memory: {} as LongTermMemoryService, generation: () => "generation", canProcess: () => true,
      preferences: () => ({ ...DEFAULT_LEARNING_PREFERENCES, processingExcludedApplications: ["browser"] }) });
    expect(ready!.observations).toHaveLength(1); expect(ready!.reviewProgress).toBeUndefined();
    expect(f.journal.items.every((item) => item.reviewProgress === undefined)).toBe(true);
    await f.journal.clearPending(); expect((await f.store.read()).batches).toEqual([]);
  });

  test("reconciles terminal receipts without keeping raw responses and rejects malformed saved checkpoints", async () => {
    const f = await fixture(); await f.journal.persist({ ...DEFAULT_LEARNING_PREFERENCES, processingPaused: false });
    await f.journal.replace({ ...batch(), reviewProgress: progress() });
    const reopened = await f.reopen(async () => ({ batchId: "batch", recordIds: ["memory"], createdAt: new Date(NOW).toISOString() }));
    expect(reopened.items[0]).toMatchObject({ status: "saved" }); expect(reopened.items[0]!.reviewProgress).toBeUndefined();
    const file = join(f.directory, "state.json");
    const state = JSON.parse(await readFile(file, "utf8")); state.batches[0].reviewProgress = { method: "anything" };
    await writeFile(file, JSON.stringify(state)); await expect(f.store.read()).rejects.toThrow("learning_review_progress_invalid");
  });

  test("expired observations cannot be revived by a late checkpoint save", async () => {
    const f = await fixture(); const current = batch();
    const expired = { ...current, createdAt: new Date(NOW - 86_400_001).toISOString(), reviewProgress: progress() };
    await expect(f.journal.replace(expired)).rejects.toThrow("learning_batch_expired");
    expect(f.journal.items).toEqual([]); expect((await f.store.read()).batches).toEqual([]);
  });

  test("refuses a checkpoint published after cancellation", async () => {
    const f = await fixture(); const controller = new AbortController();
    const run = processor(f.journal, batch(), async (input) => {
      controller.abort(new Error("learning_processing_paused"));
      await input.progress!.save(progress()); return [];
    });
    await processLearningBatch({ ...run.options, signal: controller.signal });
    expect(f.journal.items[0]!.reviewProgress).toBeUndefined(); expect(run.apply).not.toHaveBeenCalled();
  });
});

describe("scheduled review checkpoints in the existing reassessment state", () => {
  const entries = [{ kind: "candidate" as const, id: "candidate", version: "one" }];
  const fingerprint = "c".repeat(64);
  test("reopens an interrupted reservation on restart and clears progress on commit", async () => {
    const f = await fixture(); const store = createReassessmentStateStore(f.directory);
    expect((await store.read()).reviewProgress).toBeUndefined();
    await store.reserve(fingerprint, entries, NOW, () => {});
    await store.saveProgress(fingerprint, entries, progress());
    const restarted = createReassessmentStateStore(f.directory);
    const resumed = await restarted.resumeProgress(NOW + 1_000);
    expect(resumed.blockedEntries).toEqual([]); expect(resumed.reviewProgress).toEqual(progress());
    expect(await restarted.reserve(fingerprint, entries, NOW + 1_000, () => {})).toBe(true);
    expect((await restarted.read()).reviewProgress).toEqual(progress());
    await restarted.complete(fingerprint, entries);
    expect((await restarted.read()).reviewProgress).toBeUndefined();
  });
  test("retains checkpoints after resource deferral, but invalidates changed context and expiry", async () => {
    const f = await fixture(); const store = createReassessmentStateStore(f.directory);
    await store.reserve(fingerprint, entries, NOW, () => {}); await store.saveProgress(fingerprint, entries, progress());
    await store.failed(fingerprint, entries, "co_worker_model_daily_budget_exhausted", true);
    expect((await store.read()).reviewProgress).toEqual(progress());
    await store.reserve("d".repeat(64), entries, NOW + 1_000, () => {});
    expect((await store.read()).reviewProgress).toBeUndefined();
    await store.saveProgress("d".repeat(64), entries, progress());
    const expired = await store.resumeProgress(NOW + 86_400_001);
    expect(expired.reviewProgress).toBeUndefined(); expect(expired.blockedEntries).toEqual([]);
  });
  test("rechecks reservation ownership inside the checkpoint write and never overwrites after cancellation", async () => {
    const f = await fixture(); const store = createReassessmentStateStore(f.directory);
    await store.reserve(fingerprint, entries, NOW, () => {});
    await store.saveProgress(fingerprint, entries, progress());
    await expect(store.saveProgress(fingerprint, entries, progress("timing"), () => {
      throw new Error("learning_processing_paused");
    })).rejects.toThrow("learning_processing_paused");
    expect((await store.read()).reviewProgress).toEqual(progress());
  });
});
