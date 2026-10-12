import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryStore } from "../../../plugins/memory/source/store.js";
import type { MemoryEntry } from "../../../plugins/memory/source/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const NOW = "2026-01-01T00:00:00.000Z";
const ADDED_CONTENT = "Synthetic memory added during a held read.";
const roots: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.rename).mockImplementation(actual.rename);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

async function fixture() {
  const parent = join(process.cwd(),
    ".codex/artifacts/windows-session-steering-20261010/memory-review/native-fixtures");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, "case-"));
  roots.push(root);
  const target = join(root, "memory.json");
  const options = { filePath: target, now: () => new Date(NOW) };
  const first = new MemoryStore(options), second = new MemoryStore(options);
  await first.add("Synthetic first memory.");
  await first.add("Synthetic retained memory.");
  const original = await second.read();
  const originalBytes = await fs.readFile(target);
  return { root, target, first, second, original, originalBytes };
}

function pauseFirstCanonicalReader(target: string) {
  const opened = gate(), released = gate();
  const open = vi.mocked(fs.open).getMockImplementation()!;
  let intercepted = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) !== target || args[1] !== "r" || intercepted) return handle;
    intercepted = true;
    opened.release();
    await released.ready;
    return handle;
  });
  return { opened: opened.ready, release: released.release };
}

function observeCanonicalRenames(target: string) {
  const denied = gate();
  const attempts: { temporary: string; committed: boolean; error?: unknown }[] = [];
  const rename = vi.mocked(fs.rename).getMockImplementation()!;
  vi.mocked(fs.rename).mockImplementation(async (temporary, destination) => {
    if (String(destination) !== target) return rename(temporary, destination);
    const attempt: (typeof attempts)[number] = { temporary: String(temporary), committed: false };
    attempts.push(attempt);
    try {
      await rename(temporary, destination);
      attempt.committed = true;
    } catch (error) {
      attempt.error = error;
      denied.release();
      throw error;
    }
  });
  return { attempts, denied: denied.ready };
}

async function expectCleanStoreRoot(root: string) {
  expect(await fs.readdir(root)).toEqual(["memory.json"]);
}

const mutations = [
  {
    operation: "add", apply: (store: MemoryStore) => store.add(ADDED_CONTENT),
    result: { id: "mem-0003", content: ADDED_CONTENT, createdAt: NOW },
    ids: ["mem-0001", "mem-0002", "mem-0003"], nextSequence: 4,
  },
  {
    operation: "delete", apply: (store: MemoryStore) => store.delete("mem-0001"),
    result: 1, ids: ["mem-0002"], nextSequence: 3,
  },
];

describe.skipIf(process.platform !== "win32").each(mutations)(
  "Windows MEMORY $operation publication", ({ apply, result, ids, nextSequence }) => {
    test.each([
      { name: "same-instance", independent: false },
      { name: "independent-instance", independent: true },
    ])("a held $name public reader releases before one prepared mutation is published", async ({ independent }) => {
      const f = await fixture();
      const paused = pauseFirstCanonicalReader(f.target);
      const observed = observeCanonicalRenames(f.target);
      const reading = f.first.read();
      void reading.catch(() => undefined);
      let mutation: Promise<MemoryEntry | number> | undefined;
      try {
        await Promise.race([paused.opened, reading.then(() => {
          throw new Error("Public memory read did not hold the canonical file.");
        })]);
        mutation = apply(independent ? f.second : f.first);
        void mutation.catch(() => undefined);
        await Promise.race([observed.denied, mutation.then(() => {
          throw new Error("Memory mutation completed while its Windows reader was held.");
        })]);
        expect(observed.attempts[0]!.error).toMatchObject({ code: "EPERM", syscall: "rename" });
        paused.release();
        expect(await mutation).toEqual(result);
        expect(await reading).toEqual(f.original);
        expect(observed.attempts.filter((attempt) => attempt.committed)).toHaveLength(1);
        expect(new Set(observed.attempts.map((attempt) => attempt.temporary)).size).toBe(1);
        const saved = await f.first.read();
        expect(saved.entries.map((entry) => entry.id)).toEqual(ids);
        expect(saved.nextSequence).toBe(nextSequence);
        expect(await f.second.read()).toEqual(saved);
        await expectCleanStoreRoot(f.root);
      } finally {
        paused.release();
        await Promise.allSettled(mutation ? [reading, mutation] : [reading]);
      }
    }, 30_000);

    test("a reader held beyond the budget preserves the original bytes, failure, cleanup and next ID", async () => {
      const f = await fixture();
      const reader = await fs.open(f.target, "r");
      const observed = observeCanonicalRenames(f.target);
      const started = performance.now();
      try {
        const outcome = await apply(f.first).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") throw new Error("Blocked memory mutation reported success.");
        expect(outcome.error).toMatchObject({ code: "EPERM", syscall: "rename" });
        expect(outcome.error).toBe(observed.attempts.at(-1)!.error);
        expect(performance.now() - started).toBeGreaterThanOrEqual(900);
        expect(observed.attempts.length).toBeGreaterThan(1);
        expect(observed.attempts.length).toBeLessThanOrEqual(41);
        expect(observed.attempts.every((attempt) => !attempt.committed)).toBe(true);
        expect(new Set(observed.attempts.map((attempt) => attempt.temporary)).size).toBe(1);
        expect(await fs.readFile(f.target)).toEqual(f.originalBytes);
        await expectCleanStoreRoot(f.root);
      } finally {
        await reader.close();
      }
      expect(await f.first.add("Synthetic follow-up after rejected publication.")).toMatchObject({ id: "mem-0003" });
      const recovered = await f.second.read();
      expect(recovered.entries.map((entry) => entry.id)).toEqual(["mem-0001", "mem-0002", "mem-0003"]);
      expect(recovered.nextSequence).toBe(4);
      await expectCleanStoreRoot(f.root);
    }, 30_000);
  },
);


test.skipIf(process.platform !== "win32")("a competing MEMORY writer waits for the retrying owner's lock before allocating its ID", async () => {
  const f = await fixture();
  const paused = pauseFirstCanonicalReader(f.target);
  const observed = observeCanonicalRenames(f.target);
  const reading = f.first.read();
  void reading.catch(() => undefined);
  const pending: Promise<unknown>[] = [reading];
  try {
    await Promise.race([paused.opened, reading.then(() => {
      throw new Error("Public memory reader was not held.");
    })]);
    const firstMutation = f.first.add("Synthetic first waiting writer.");
    pending.push(firstMutation);
    void firstMutation.catch(() => undefined);
    await Promise.race([observed.denied, firstMutation.then(() => {
      throw new Error("First writer did not encounter the held Windows reader.");
    })]);
    expect(observed.attempts[0]!.error).toMatchObject({ code: "EPERM" });
    const contenderObserved = gate();
    const open = vi.mocked(fs.open).getMockImplementation()!;
    let contenderCanonicalReads = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === f.target && args[1] === "r") contenderCanonicalReads += 1;
      if (dirname(String(args[0])) === join(`${f.target}.lock`, "lease")) contenderObserved.release();
      return handle;
    });
    const secondMutation = f.second.add("Synthetic competing writer.");
    pending.push(secondMutation);
    void secondMutation.catch(() => undefined);
    await Promise.race([contenderObserved.ready, secondMutation.then(() => {
      throw new Error("Competing writer entered before observing the live owner's lock.");
    })]);
    expect(contenderCanonicalReads).toBe(0);
    expect(observed.attempts.every((attempt) => !attempt.committed)).toBe(true);
    expect(new Set(observed.attempts.map((attempt) => attempt.temporary)).size).toBe(1);
    expect((await fs.readdir(f.root)).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    paused.release();
    const [first, second] = await Promise.all([firstMutation, secondMutation]);
    expect(first.id).toBe("mem-0003");
    expect(second.id).toBe("mem-0004");
    expect(await reading).toEqual(f.original);
    const saved = await f.first.read();
    expect(saved.entries.map((entry) => entry.id)).toEqual(["mem-0001", "mem-0002", "mem-0003", "mem-0004"]);
    expect(saved.nextSequence).toBe(5);
    expect(observed.attempts.filter((attempt) => attempt.committed)).toHaveLength(2);
    await expectCleanStoreRoot(f.root);
  } finally {
    paused.release();
    await Promise.allSettled(pending);
  }
}, 30_000);
