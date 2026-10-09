import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { saveDurableSessionFile } from "../durable-session-commit.js";
import { deleteSessionFile, saveSessionFile } from "../session-store.js";
import type { SessionRecord } from "../types.js";
import { listSessionMetadata, sessionSourceStamp } from "./store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "session-metadata-"));
  roots.push(directory);
  return directory;
}

function session(id: string): SessionRecord {
  return {
    id, title: id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    lastAgentMode: "reasoning", messageCount: 3,
    messages: [
      { id: "msg-1", role: "user", content: "User text", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "proposal:answer", role: "assistant", content: "Answer\n   preview", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "msg-3", role: "assistant", content: "Tool observation", grounding: "tool_observation", createdAt: "2026-01-01T00:00:02.000Z" },
    ],
  };
}

function sourceReads(directory: string): string[] {
  return vi.mocked(fs.open).mock.calls.map(([path]) => String(path))
    .filter((path) => path.startsWith(`${directory}/`) && !path.includes("/.metadata/") && path.endsWith(".json"));
}

async function writeLegacy(directory: string, record: SessionRecord) {
  await fs.writeFile(join(directory, `${record.id}.json`), JSON.stringify(record));
}

describe("persisted session metadata", () => {
  test("bounds concurrent backfill reads while completing every session", async () => {
    const directory = await fixture();
    await Promise.all(Array.from({ length: 13 }, (_, index) => writeLegacy(directory, session(`batch-${index}`))));
    let active = 0;
    let peak = 0;
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes("/.metadata/")) return handle;
      active += 1;
      peak = Math.max(peak, active);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        active -= 1;
      });
      return handle;
    });
    expect(await listSessionMetadata(directory)).toHaveLength(13);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
  });

  test("backfills once and reuses the disk index after module restart without reading source bodies", async () => {
    const directory = await fixture();
    const record = session("legacy");
    await writeLegacy(directory, record);
    const original = await fs.readFile(join(directory, "legacy.json"), "utf8");
    const [first, concurrent] = await Promise.all([
      listSessionMetadata(directory), listSessionMetadata(directory),
    ]);
    expect(concurrent).toEqual(first);
    expect(sourceReads(directory)).toEqual([join(directory, "legacy.json")]);
    expect(first[0]).toMatchObject({
      summary: { id: "legacy", lastMessagePreview: "Answer preview", latestMessageId: "proposal:answer" },
      messages: [
        { id: 1, role: "user", createdAt: Date.parse(record.messages[0]!.createdAt) },
        { id: "proposal:answer", role: "assistant", createdAt: Date.parse(record.messages[1]!.createdAt) },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("User text");
    expect(JSON.stringify(first)).not.toContain("Tool observation");
    vi.clearAllMocks();
    vi.resetModules();
    const restarted = await import("./store.js");
    expect(await restarted.listSessionMetadata(directory)).toEqual(first);
    expect(sourceReads(directory)).toEqual([]);
    expect(vi.mocked(fs.readFile).mock.calls.map(([path]) => String(path)))
      .toEqual([join(directory, ".metadata", "legacy.json")]);
    expect(await fs.readFile(join(directory, "legacy.json"), "utf8")).toBe(original);
  });

  test("resumes an interrupted backfill without rebuilding completed entries", async () => {
    const directory = await fixture();
    await writeLegacy(directory, session("a"));
    await fs.writeFile(join(directory, "b.json"), "incomplete");
    await expect(listSessionMetadata(directory)).rejects.toThrow();
    expect(await fs.readdir(join(directory, ".metadata"))).toEqual(["a.json"]);
    await writeLegacy(directory, session("b"));
    vi.clearAllMocks();
    expect(await listSessionMetadata(directory)).toHaveLength(2);
    expect(sourceReads(directory)).toEqual([join(directory, "b.json")]);
  });

  test("both commit paths update only their own metadata, including parallel sessions and clear", async () => {
    const directory = await fixture();
    const first = session("ordinary");
    const second = session("durable");
    await Promise.all([saveSessionFile(directory, first), saveDurableSessionFile(directory, second)]);
    const untouched = await fs.readFile(join(directory, ".metadata", "durable.json"), "utf8");
    first.title = "Renamed";
    first.messages = [];
    first.messageCount = 0;
    first.updatedAt = "2026-01-02T00:00:00.000Z";
    await saveSessionFile(directory, first);
    vi.clearAllMocks();
    const records = await listSessionMetadata(directory);
    expect(sourceReads(directory)).toEqual([]);
    expect(records[0]).toMatchObject({ summary: { title: "Renamed", lastMessagePreview: "", latestMessageId: null }, messages: [] });
    expect(await fs.readFile(join(directory, ".metadata", "durable.json"), "utf8")).toBe(untouched);
    await deleteSessionFile(directory, first.id);
    expect((await listSessionMetadata(directory)).map((record) => record.summary.id)).toEqual([second.id]);
    expect(await fs.readdir(join(directory, ".metadata"))).toEqual(["durable.json"]);
  });

  test("repairs only a stale entry after a source-only commit and a corrupt derived record", async () => {
    const directory = await fixture();
    const changed = session("changed");
    await Promise.all([saveSessionFile(directory, changed), saveSessionFile(directory, session("untouched"))]);
    changed.title = "Committed while index was unavailable";
    const replacement = join(directory, "replacement.tmp");
    await fs.writeFile(replacement, JSON.stringify(changed));
    await fs.rename(replacement, join(directory, "changed.json"));
    vi.clearAllMocks();
    expect((await listSessionMetadata(directory))[0]!.summary.title).toBe(changed.title);
    expect(sourceReads(directory)).toEqual([join(directory, "changed.json")]);
    await fs.writeFile(join(directory, ".metadata", "changed.json"), "broken");
    vi.clearAllMocks();
    await listSessionMetadata(directory);
    expect(sourceReads(directory)).toEqual([join(directory, "changed.json")]);
  });

  test("a backfill that overlaps a committed update cannot publish the old record as current", async () => {
    const directory = await fixture();
    const record = session("overlap");
    await writeLegacy(directory, record);
    let release!: () => void;
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const opening = new Promise<void>((resolve) => { opened = resolve; });
    const openFile = vi.mocked(fs.open).getMockImplementation()!;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await openFile(...args);
      opened();
      await gate;
      return handle;
    });
    const backfill = listSessionMetadata(directory);
    await opening;
    record.title = "Newer committed title";
    try {
      await saveSessionFile(directory, record);
    } finally {
      release();
    }
    await backfill;
    vi.clearAllMocks();
    expect((await listSessionMetadata(directory))[0]!.summary.title).toBe(record.title);
    expect(sourceReads(directory)).toEqual([]);
  });

  test.each([saveSessionFile, saveDurableSessionFile])("index write failure does not fail the committed session", async (save) => {
    const directory = await fixture();
    await fs.writeFile(join(directory, ".metadata"), "unavailable index directory");
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const record = session("committed");
    await expect(save(directory, record)).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(join(directory, "committed.json"), "utf8"))).toEqual(record);
    expect(warning).toHaveBeenCalledWith(expect.any(String), { code: "SESSION_METADATA_WRITE_FAILED" });
    expect((await listSessionMetadata(directory))[0]!.summary.title).toBe(record.title);
    await fs.rm(join(directory, ".metadata"));
    expect((await listSessionMetadata(directory))[0]!.summary.title).toBe(record.title);
  });

  test.each(["missing", "stale"])("lists a readable session when its %s index cannot be written", async (state) => {
    const directory = await fixture();
    const record = session("readable");
    if (state === "stale") await saveSessionFile(directory, record);
    record.title = "Current canonical title";
    await writeLegacy(directory, record);
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const write = vi.mocked(fs.writeFile).getMockImplementation()!;
    vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
      if (String(args[0]).includes("/.metadata/")) throw Object.assign(new Error("read-only"), { code: "EACCES" });
      return write(...args);
    });
    expect((await listSessionMetadata(directory))[0]!.summary.title).toBe(record.title);
    expect(process.emitWarning).toHaveBeenCalledWith(expect.any(String), { code: "SESSION_METADATA_WRITE_FAILED" });
  });

  test.each(["save", "delete"] as const)("a paused publication cannot undo a newer %s from another index instance", async (operation) => {
    const directory = await fixture();
    const record = session("publication");
    await writeLegacy(directory, record);
    const target = join(directory, ".metadata", "publication.json");
    let release!: () => void;
    let paused!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atPublication = new Promise<void>((resolve) => { paused = resolve; });
    const rename = vi.mocked(fs.rename).getMockImplementation()!;
    let intercepted = false;
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (String(args[1]) !== target || intercepted) return rename(...args);
      intercepted = true;
      paused();
      await gate;
      return rename(...args);
    });
    const backfill = listSessionMetadata(directory);
    await atPublication;
    // Separate module state models the Web list and Runtime owner sharing only disk locks.
    vi.resetModules();
    const independent = await import("./store.js");
    let mutation: Promise<void>;
    try {
      if (operation === "delete") {
        await fs.rm(join(directory, "publication.json"));
        mutation = independent.deleteSessionMetadata(directory, record.id);
      } else {
        record.title = "Newer committed title";
        await writeLegacy(directory, record);
        const stamp = sessionSourceStamp(await fs.stat(join(directory, "publication.json"), { bigint: true }));
        mutation = independent.updateSessionMetadata(directory, record, stamp);
      }
    } finally {
      release();
    }
    await Promise.all([backfill, mutation!]);
    vi.clearAllMocks();
    if (operation === "delete") {
      expect(await fs.readdir(join(directory, ".metadata"))).toEqual([]);
      expect(await independent.listSessionMetadata(directory)).toEqual([]);
      return;
    }
    expect((await independent.listSessionMetadata(directory))[0]!.summary.title).toBe(record.title);
    expect(sourceReads(directory)).toEqual([]);
  });
});
