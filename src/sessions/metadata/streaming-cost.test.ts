import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionService } from "../session-service.js";
import { saveSessionFile } from "../session-store.js";
import type { SessionRecord } from "../types.js";
import type { SessionRequestLifecycleSnapshot } from "../request-lifecycle/contracts.js";
import { listSessionMetadata } from "./store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), writeFile: vi.fn(actual.writeFile), readFile: vi.fn(actual.readFile) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = join(process.cwd(), ".codex/artifacts/session-metadata-review-tests");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(join(root, "streaming-"));
  directories.push(directory);
  const timestamp = "2026-10-06T00:00:00.000Z";
  const record: SessionRecord = {
    id: "streaming", title: "Long conversation", createdAt: timestamp, updatedAt: timestamp,
    lastAgentMode: "reasoning", messageCount: 1000,
    messages: Array.from({ length: 1000 }, (_, index) => ({
      id: `msg-${index + 1}`, role: index % 2 === 0 ? "user" : "assistant",
      content: "Existing message", createdAt: timestamp,
    })),
  };
  await saveSessionFile(directory, record);
  return directory;
}

test.each(["legacy", "lifecycle"])("%s streaming writes bounded receipts and preserves the indexed history", async (mode) => {
  const directory = await fixture();
  let time = Date.parse("2026-10-06T00:00:01.000Z");
  const service = new SessionService({ sessionsDir: directory, now: () => new Date(time) });
  let state: SessionRequestLifecycleSnapshot | undefined;
  if (mode === "legacy") await service.startRequestStream("streaming", "request");
  if (mode === "lifecycle") {
    const started = await service.requestLifecycle.startActivation("streaming", {
      requestId: "request", activationId: "activation", ownerEpoch: "owner",
    });
    if (!started.accepted) throw new Error(started.reason);
    state = started.current;
  }
  const indexPath = join(directory, ".metadata", "streaming.json");
  const original = await fs.readFile(indexPath, "utf8");
  vi.clearAllMocks();
  for (let index = 0; index < 12; index += 1) {
    time += 1000;
    const payload = index % 2 === 0
      ? { type: "token", text: "answer chunk" }
      : { type: "event", name: "thinking.delta", text: "thinking chunk" };
    if (mode === "legacy") {
      await service.appendRequestEvent("streaming", "request", payload);
      continue;
    }
    const result = await service.requestLifecycle.appendActivationEvent("streaming", {
      expected: { requestId: "request", generation: state!.generation, revision: state!.revision, ...state!.activation! },
      payload,
    });
    if (!result.accepted) throw new Error(result.reason);
    state = result.current;
  }
  const writes = vi.mocked(fs.writeFile).mock.calls.filter(([path]) => String(path).includes("/.metadata/"));
  expect(writes).toHaveLength(12);
  for (const [path, content] of writes) {
    expect(String(path)).toContain("streaming.json.source.");
    expect(Buffer.byteLength(String(content))).toBeLessThan(512);
  }
  expect(vi.mocked(fs.readFile).mock.calls.some(([path]) => String(path) === indexPath)).toBe(false);
  expect(await fs.readFile(indexPath, "utf8")).toBe(original);
  expect((await service.getSessionById("streaming"))!.requests![0]!.lastSeqNo).toBe(12);
  vi.clearAllMocks();
  vi.resetModules();
  const restarted = await import("./store.js");
  const [indexed] = await restarted.listSessionMetadata(directory);
  expect(indexed!.messages).toHaveLength(1000);
  expect(indexed!.summary.updatedAt).toBe(time);
  expect(vi.mocked(fs.open).mock.calls.filter(([path]) => String(path).endsWith("/streaming.json"))).toEqual([]);

  await service.appendMessage("streaming", "assistant", "Newly saved answer");
  expect((await listSessionMetadata(directory))[0]!.summary.lastMessagePreview).toBe("Newly saved answer");
  if (mode === "legacy") await service.appendRequestEvent("streaming", "request", { type: "completed" });
  expect((await listSessionMetadata(directory))[0]!.messages).toHaveLength(1001);
});

test("an event receipt cannot validate an older projection after a missed message index update", async () => {
  const directory = await fixture();
  const indexPath = join(directory, ".metadata", "streaming.json");
  const previous = await fs.readFile(indexPath, "utf8");
  const service = new SessionService({ sessionsDir: directory });
  await service.appendMessage("streaming", "assistant", "Durably saved new answer");
  // Model a lost projection update; a subsequent event must not bless the old history.
  await fs.writeFile(indexPath, previous);
  await service.appendRequestEvent("streaming", "request", { type: "token", text: "next chunk" });
  expect((await listSessionMetadata(directory))[0]!.summary.lastMessagePreview).toBe("Durably saved new answer");
  vi.clearAllMocks();
  await service.appendRequestEvent("streaming", "request", { type: "completed" });
  expect((await listSessionMetadata(directory))[0]!.messages).toHaveLength(1001);
  expect(vi.mocked(fs.open).mock.calls.filter(([path]) => String(path).endsWith("/streaming.json"))).toEqual([]);
});
