import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LearningBatch } from "../passive-learning/contracts.js";
import { LearningJournal } from "../passive-learning/journal.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";

const directories: string[] = [];
const now = Date.parse("2026-09-25T12:00:00.000Z");
const historyByteLimit = 4 * 1024 * 1024;
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function batch(id: string, status: LearningBatch["status"] = "pending"): LearningBatch {
  return { id, status, createdAt: new Date(now).toISOString(), generation: "generation", recordIds: [],
    observations: [0, 1].map((index) => ({ id: `${id}-${index}`, deviceId: "computer", sequence: index + 1,
      timestamp: new Date(now).toISOString(), source: { app: "editor", windowId: "1" },
      content: `Complete observation ${id}-${index}`, kind: "view", extraction: "uia", coverage: "complete" })),
  };
}

function parts(original: LearningBatch): readonly LearningBatch[] {
  return [
    { ...original, status: "pending", reason: "learning_batch_partitioned", observations: original.observations.slice(0, 1) },
    { ...original, id: `${original.id}-part-2`, status: "pending", reason: "learning_batch_partitioned", observations: original.observations.slice(1) },
  ];
}

async function fixture(initial: readonly LearningBatch[]) {
  const directory = await mkdtemp(join(tmpdir(), "learning-partition-"));
  directories.push(directory);
  const changed = vi.fn();
  const journal = new LearningJournal({ directory, now: () => now, preferences: () => DEFAULT_LEARNING_PREFERENCES,
    changed, failed: vi.fn() });
  await journal.load();
  await journal.replaceMany(initial);
  changed.mockClear();
  return { directory, journal, changed, store: createLearningStateStore(directory) };
}

describe("durable bounded learning journal partition", () => {
  test("preserves both parts of the oldest batch by evicting terminal history at the 50-entry limit", async () => {
    const original = batch("oldest", "processing");
    const f = await fixture([original, ...Array.from({ length: 49 }, (_, index) => batch(`terminal-${index}`, "discarded"))]);
    const partition = parts(original);
    expect(await f.journal.partition(partition)).toBe(true);
    const disk = (await f.store.read()).batches;
    expect(disk).toHaveLength(50);
    expect(disk).toEqual(f.journal.items);
    const retained = disk.filter((entry) => partition.some((part) => part.id === entry.id));
    expect(retained).toEqual(partition);
    expect(retained.flatMap((entry) => entry.observations)).toEqual(original.observations);
    expect(disk.filter((entry) => entry.status === "discarded")).toHaveLength(48);
    const restarted = new LearningJournal({ directory: f.directory, now: () => now,
      preferences: () => DEFAULT_LEARNING_PREFERENCES, changed: vi.fn(), failed: vi.fn() });
    await restarted.load("restarted");
    expect(restarted.items.filter((entry) => entry.status === "pending").flatMap((entry) => entry.observations)).toEqual(original.observations);
  });

  test("refuses a split when all 50 retained batches are unprocessed, without changing memory or disk", async () => {
    const original = batch("oldest", "processing");
    const f = await fixture([original, ...Array.from({ length: 49 }, (_, index) => batch(`pending-${index}`))]);
    const before = await f.store.read();
    expect(await f.journal.partition(parts(original))).toBe(false);
    expect(f.journal.items).toEqual(before.batches);
    expect(await f.store.read()).toEqual(before);
    expect(f.changed).not.toHaveBeenCalled();
  });

  test.each(["pending", "discarded"] as const)("preserves pending evidence at the byte cap with %s neighboring history", async (status) => {
    const original = batch("oldest", "processing");
    let neighbor = batch("large", status);
    neighbor = { ...neighbor, observations: [{ ...neighbor.observations[0]!, content: "" }] };
    const size = Buffer.byteLength(JSON.stringify(original)) + Buffer.byteLength(JSON.stringify(neighbor));
    neighbor = { ...neighbor, observations: [{ ...neighbor.observations[0]!, content: "x".repeat(historyByteLimit - 32 - size) }] };
    const initial = [original, neighbor];
    const partition = parts(original);
    const totalBytes = (entries: readonly LearningBatch[]) => entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
    expect(totalBytes(initial)).toBeLessThan(historyByteLimit);
    expect(totalBytes([...partition, neighbor])).toBeGreaterThan(historyByteLimit);
    const f = await fixture(initial);
    const before = await f.store.read();
    expect(before.batches).toHaveLength(2);
    const accepted = await f.journal.partition(partition);
    const after = await f.store.read();
    if (status === "pending") {
      expect(accepted).toBe(false);
      expect(after).toEqual(before);
      expect(f.journal.items).toEqual(before.batches);
      expect(f.changed).not.toHaveBeenCalled();
      return;
    }
    expect(accepted).toBe(true);
    expect(after.batches).toEqual(partition);
    expect(f.journal.items).toEqual(partition);
    expect(after.batches.flatMap((entry) => entry.observations)).toEqual(original.observations);
    expect(totalBytes(after.batches)).toBeLessThan(historyByteLimit);
  });
});
