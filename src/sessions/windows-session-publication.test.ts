import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { saveDurableSessionFile } from "./durable-session-commit.js";
import { listSessionMetadata } from "./metadata/store.js";
import { loadSessionFile, saveSessionFile } from "./session-store.js";
import type { SessionRecord } from "./types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

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
  const parent = join(process.cwd(), ".codex/artifacts/windows-public-plugins/session-publication");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, "case-"));
  roots.push(root);
  const old: SessionRecord = {
    id: "held-session", title: "Before publication", lastAgentMode: "reasoning",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    messages: [{ id: "original", role: "user", content: "Synthetic original",
      createdAt: "2026-01-01T00:00:00.000Z" }],
  };
  const next: SessionRecord = {
    ...old, title: "After publication", updatedAt: "2026-01-01T00:00:01.000Z",
    messageCount: 2,
    messages: [...old.messages, { id: "new", role: "assistant", content: "Synthetic replacement",
      createdAt: "2026-01-01T00:00:01.000Z" }],
  };
  const target = join(root, `${old.id}.json`);
  await fs.writeFile(target, JSON.stringify(old), "utf8");
  return { root, target, old, next };
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

async function awaitDeniedPublication(denied: Promise<void>, saving: Promise<void>) {
  await Promise.race([denied, saving.then(() => {
    throw new Error("Canonical publication completed while its Windows reader was held.");
  })]);
}

async function expectNoPreparedFiles(root: string) {
  expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

const writers = [
  { name: "ordinary session save", save: saveSessionFile },
  { name: "durable session save", save: saveDurableSessionFile },
];

describe.skipIf(process.platform !== "win32").each(writers)("Windows $name", ({ save }) => {
  test("publishes once after the actual metadata reader releases the canonical file", async () => {
    const f = await fixture();
    const opened = gate(), releaseReader = gate();
    const open = vi.mocked(fs.open).getMockImplementation()!;
    let intercepted = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) !== f.target || args[1] !== "r" || intercepted) return handle;
      intercepted = true;
      opened.release();
      await releaseReader.ready;
      return handle;
    });
    const observed = observeCanonicalRenames(f.target);
    const listing = listSessionMetadata(f.root);
    void listing.catch(() => undefined);
    let saving: Promise<void> | undefined;
    try {
      await Promise.race([opened.ready, listing.then(() => {
        throw new Error("Metadata listing did not open the canonical session.");
      })]);
      saving = save(f.root, f.next);
      void saving.catch(() => undefined);
      await awaitDeniedPublication(observed.denied, saving);
      expect(observed.attempts[0]!.error).toMatchObject({ code: "EPERM", syscall: "rename" });
      releaseReader.release();
      await saving;
      await listing;
      expect(observed.attempts.filter((attempt) => attempt.committed)).toHaveLength(1);
      expect(new Set(observed.attempts.map((attempt) => attempt.temporary)).size).toBe(1);
      expect(await loadSessionFile(f.root, f.next.id)).toEqual(f.next);
      expect((await listSessionMetadata(f.root))[0]!.summary.title).toBe(f.next.title);
      await expectNoPreparedFiles(f.root);
    } finally {
      releaseReader.release();
      await Promise.allSettled(saving ? [listing, saving] : [listing]);
    }
  }, 30_000);

  test("preserves EPERM and the old canonical file when a real reader outlives the retry budget", async () => {
    const f = await fixture();
    const reader = await fs.open(f.target, "r");
    const observed = observeCanonicalRenames(f.target);
    const started = performance.now();
    try {
      await expect(save(f.root, f.next)).rejects.toMatchObject({ code: "EPERM", syscall: "rename" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(900);
      expect(observed.attempts.length).toBeGreaterThan(1);
      expect(observed.attempts.length).toBeLessThanOrEqual(41);
      expect(observed.attempts.every((attempt) => !attempt.committed)).toBe(true);
      expect(new Set(observed.attempts.map((attempt) => attempt.temporary)).size).toBe(1);
      expect(await loadSessionFile(f.root, f.old.id)).toEqual(f.old);
      await expectNoPreparedFiles(f.root);
    } finally {
      await reader.close();
    }
  }, 30_000);

  test("a stale assertion during reader contention prevents publication and removes the prepared file", async () => {
    const f = await fixture();
    const reader = await fs.open(f.target, "r");
    const observed = observeCanonicalRenames(f.target);
    const stale = new Error("fixture_session_authority_stale");
    let current = true;
    const assertCurrent = vi.fn(() => { if (!current) throw stale; });
    const saving = save(f.root, f.next, assertCurrent);
    void saving.catch(() => undefined);
    try {
      await awaitDeniedPublication(observed.denied, saving);
      expect(observed.attempts[0]!.error).toMatchObject({ code: "EPERM", syscall: "rename" });
      current = false;
      await expect(saving).rejects.toBe(stale);
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      expect(observed.attempts).toHaveLength(1);
      expect(observed.attempts[0]!.committed).toBe(false);
      expect(await loadSessionFile(f.root, f.old.id)).toEqual(f.old);
      await expectNoPreparedFiles(f.root);
    } finally {
      current = false;
      await Promise.allSettled([saving]);
      await reader.close();
    }
  }, 30_000);
});
