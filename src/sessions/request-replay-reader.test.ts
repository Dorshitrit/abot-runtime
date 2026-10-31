import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionService } from "./session-service.js";
import type { SessionRecord } from "./types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});

const readFile = vi.mocked(fs.readFile).getMockImplementation()!;
const readdir = vi.mocked(fs.readdir).getMockImplementation()!;
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(fs.readFile).mockReset().mockImplementation(readFile);
  vi.mocked(fs.readdir).mockReset().mockImplementation(readdir);
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function record(id: string, requestId = "request"): SessionRecord {
  const timestamp = "2026-10-29T18:00:00.000Z";
  return {
    id, title: id, createdAt: timestamp, updatedAt: timestamp, lastAgentMode: "reasoning",
    messageCount: 0, messages: [],
    requests: [{
      requestId, sessionId: id, status: "streaming", createdAt: timestamp,
      updatedAt: timestamp, lastSeqNo: 2,
      events: [1, 2].map((seqNo) => ({
        seqNo, requestId, timestamp, type: "event",
        payload: { name: "progress", detail: { sequence: seqNo } },
      })),
    }],
  };
}

async function fixture(records: SessionRecord[] = [record("target")]) {
  const root = join(process.cwd(), ".codex/artifacts/session-replay-reader-tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(join(root, "read-"));
  directories.push(directory);
  for (const value of records)
    await fs.writeFile(join(directory, `${value.id}.json`), JSON.stringify(value));
  vi.mocked(fs.readFile).mockClear();
  vi.mocked(fs.readdir).mockClear();
  return { directory, service: new SessionService({ sessionsDir: directory }) };
}

function sourceReads() {
  return vi.mocked(fs.readFile).mock.calls.map(([path]) => String(path));
}

function holdRead(path: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    if (String(args[0]) === path) await gate;
    return readFile(...args);
  });
  return release;
}

test("a verified session hint avoids unrelated transcripts and directory scans", async () => {
  const { directory, service } = await fixture();
  await fs.writeFile(join(directory, "unrelated.json"), "unreadable unrelated transcript");
  const replay = await service.getRequestReplayById("request", 0, "target");
  expect(replay?.events).toHaveLength(2);
  expect(sourceReads()).toEqual([join(directory, "target.json")]);
  expect(fs.readdir).not.toHaveBeenCalled();
});

test("overlapping reads share raw I/O with independent cursors and returned payloads", async () => {
  const { directory, service } = await fixture();
  const path = join(directory, "target.json");
  const release = holdRead(path);
  const pending = [0, 1, 2].map((cursor) => service.getRequestReplayById("request", cursor, "target"));
  await vi.waitFor(() => expect(sourceReads()).toEqual([path]));
  release();
  const [first, second, third] = await Promise.all(pending);
  expect(first?.events.map((event) => event.seqNo)).toEqual([1, 2]);
  expect(second?.events.map((event) => event.seqNo)).toEqual([2]);
  expect(third?.events).toEqual([]);
  (first!.events[1]!.detail as { sequence: number }).sequence = 99;
  expect(second!.events[0]!.detail).toEqual({ sequence: 2 });
  expect(sourceReads()).toEqual([path]);
});

test("a later replay observes new events and terminal state rather than a settled cache", async () => {
  const { directory, service } = await fixture();
  expect((await service.getRequestReplayById("request", 0, "target"))?.finalState).toBeNull();
  const updated = record("target");
  const request = updated.requests![0]!;
  request.status = "completed";
  request.lastSeqNo = 3;
  request.events.push({
    seqNo: 3, requestId: "request", timestamp: updated.updatedAt,
    type: "completed", payload: { output: "Saved answer" },
  });
  await fs.writeFile(join(directory, "target.json"), JSON.stringify(updated));
  const replay = await service.getRequestReplayById("request", 2, "target");
  expect(replay?.events).toHaveLength(1);
  expect(replay?.finalState).toMatchObject({ status: "completed", output: "Saved answer" });
  expect(sourceReads()).toHaveLength(2);
});

test("a failed shared read is released so a later read can succeed", async () => {
  const { directory, service } = await fixture();
  await fs.writeFile(join(directory, "target.json"), "broken");
  const release = holdRead(join(directory, "target.json"));
  const pending = Promise.allSettled([
    service.getRequestReplayById("request", 0, "target"),
    service.getRequestReplayById("request", 0, "target"),
  ]);
  await vi.waitFor(() => expect(sourceReads()).toHaveLength(1));
  release();
  expect((await pending).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  await fs.writeFile(join(directory, "target.json"), JSON.stringify(record("target")));
  expect((await service.getRequestReplayById("request", 0, "target"))?.requestId).toBe("request");
  expect(sourceReads()).toHaveLength(2);
});

test.each(["other", "missing", "../outside", undefined])(
  "request identity remains authoritative when session hint is %s",
  async (hint) => {
    const { directory, service } = await fixture([record("other", "other-request"), record("target")]);
    const replay = await service.getRequestReplayById("request", 1, hint);
    expect(replay).toMatchObject({ sessionId: "target", requestId: "request" });
    expect(replay?.events.map((event) => event.seqNo)).toEqual([2]);
    expect(sourceReads().every((path) => path.startsWith(`${directory}/`))).toBe(true);
    expect(sourceReads().filter((path) => path === join(directory, "other.json"))).toHaveLength(1);
  },
);

test("unhinted lookup stops at the matching session without loading later transcripts", async () => {
  const { directory, service } = await fixture([record("a-target")]);
  await fs.writeFile(join(directory, "z-unrelated.json"), "broken");
  expect((await service.getRequestReplayById("request"))?.sessionId).toBe("a-target");
  expect(sourceReads()).toEqual([join(directory, "a-target.json")]);
});

test("a missing request scans source files sequentially without a full-corpus read", async () => {
  const { service } = await fixture(Array.from({ length: 12 }, (_, index) => record(`session-${index}`, `request-${index}`)));
  let active = 0;
  let peak = 0;
  vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    try { return await readFile(...args); }
    finally { active -= 1; }
  });
  expect(await service.getRequestReplayById("missing-request")).toBeNull();
  expect(sourceReads()).toHaveLength(12);
  expect(peak).toBe(1);
});

test("shared raw reads preserve automation authority separately for each caller", async () => {
  const { directory, service } = await fixture([]);
  const handle = await service.createAutomationSession("internal", {
    kind: "automation_node_v1", automationId: "automation", runId: "run",
    nodeId: "node", attemptId: "attempt",
  });
  await service.runAsAutomationSession(handle, async () => {
    await service.startRequestStream("internal", "private-request");
    await service.appendRequestEvent("internal", "private-request", { type: "token", text: "private result" });
  });
  vi.mocked(fs.readFile).mockClear();
  const path = join(directory, "internal.json");
  const release = holdRead(path);
  const trusted = service.runAsAutomationSession(handle, () =>
    service.getRequestReplayById("private-request", 0, "internal"));
  const ordinary = service.getRequestReplayById("private-request", 0, "internal");
  await vi.waitFor(() => expect(sourceReads()).toEqual([path]));
  release();
  const [allowed, denied] = await Promise.all([trusted, ordinary]);
  expect(allowed?.events[0]).toMatchObject({ text: "private result" });
  expect(denied).toBeNull();
  expect(sourceReads()).toEqual([path]);
});
