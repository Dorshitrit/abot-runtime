import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { SessionSnapshotOptions } from "../../sessions/snapshot.js";
import type { SessionRecord } from "../../sessions/types.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import type { RuntimeConfig } from "../ports.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const iso = (value: number) => new Date(value).toISOString();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-unread-")); roots.push(root);
  const sessions = new Map<string, SessionService>();
  const environment = (id: string) => {
    const paths = { runtimeDir: join(root, id), sessionsDir: join(root, id, "sessions") };
    if (!sessions.has(id)) sessions.set(id, new SessionService({ sessionsDir: paths.sessionsDir }));
    return { services: { config: { paths } as RuntimeConfig, sessions: sessions.get(id)! } };
  };
  const reads = new WebSessionReadStates(environment, () => 1000);
  const record: SessionRecord = {
    id: SPARK_SESSION_ID, kind: "spark", title: "SPARK", createdAt: iso(1100), updatedAt: iso(1500),
    lastAgentMode: "reasoning", messageCount: 5,
    messages: [
      { id: "msg-1", role: "user", content: "Question", createdAt: iso(1100) },
      { id: "msg-2", role: "assistant", kind: "tool_approval_request", content: "Approval one", createdAt: iso(1200), requestId: "r" },
      { id: "msg-3", role: "assistant", kind: "tool_approval_request", content: "Approval two", createdAt: iso(1300), requestId: "r" },
      { id: "msg-4", role: "assistant", kind: "terminal", content: "Final answer", createdAt: iso(1400), requestId: "r" },
      { id: "msg-5", role: "assistant", content: "Older-format answer", createdAt: iso(1500), requestId: "later" },
    ],
  };
  for (const id of ["dev", "prod"]) {
    const paths = environment(id).services.config.paths;
    await mkdir(paths.sessionsDir, { recursive: true });
    await writeFile(join(paths.sessionsDir, `${SPARK_SESSION_ID}.json`), JSON.stringify(record));
  }
  async function snapshot(options: SessionSnapshotOptions = {}) {
    return (await environment("dev").services.sessions.getSessionSnapshot(SPARK_SESSION_ID, options))!;
  }
  async function generation() {
    const state = await reads.project("dev", await snapshot());
    if (!("readGeneration" in state)) throw new Error("Missing SPARK read generation");
    return state.readGeneration;
  }
  async function readSidecar() {
    const directory = join(root, "dev", "web-ui", "read-state");
    const [name] = await readdir(directory);
    return readFile(join(directory, name!), "utf8");
  }
  return { root, record, environment, reads, snapshot, generation, readSidecar };
}

const projections: [string, SessionSnapshotOptions][] = [
  ["full history", {}], ["paged history", { page: { limit: 1 } }], ["identity-only history", { identitiesOnly: true }],
];

describe("SPARK unread follows visible conversation messages", () => {
  test.each(projections)("hidden approvals cannot leave a permanent unread badge with %s", async (_label, options) => {
    const f = await fixture(); const generation = await f.generation();
    const path = join(f.root, "dev", "sessions", `${SPARK_SESSION_ID}.json`);
    const original = await readFile(path, "utf8");
    await f.reads.markVisible("dev", SPARK_SESSION_ID, [4], generation, [{ id: 4, createdAt: 1400, requestId: "r" }]);
    const sidecar = await f.readSidecar();
    expect(await f.reads.project("dev", await f.snapshot(options))).toMatchObject({ unreadMessageIds: [5], unreadCount: 1, lastReadMessageId: 4 });
    expect(await f.readSidecar()).toBe(sidecar);
    expect(await f.reads.markVisible("dev", SPARK_SESSION_ID, [5], generation, [{ id: 5, createdAt: 1500, requestId: "later" }]))
      .toMatchObject({ unreadMessageIds: [], unreadCount: 0, hasUnread: false });
    const restarted = new WebSessionReadStates(f.environment, () => 9000);
    expect(await restarted.project("dev", await f.snapshot(options))).toMatchObject({ unreadMessageIds: [], unreadCount: 0 });
    expect(await restarted.assistantReadEvidence("dev", SPARK_SESSION_ID)).toEqual({ status: "available", messages: [
      { messageId: "4", createdAt: 1400, requestId: "r", readAt: expect.any(Number) },
      { messageId: "5", createdAt: 1500, requestId: "later", readAt: expect.any(Number) },
    ] });
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await f.snapshot()).messages.filter((message) => message.kind === "tool_approval_request")).toHaveLength(2);
    const other = (await f.environment("prod").services.sessions.getSessionSnapshot(SPARK_SESSION_ID))!;
    expect(await restarted.project("prod", other)).toMatchObject({ unreadMessageIds: [4, 5], unreadCount: 2 });
  });

  test("only actual reply identities can produce explicit read evidence", async () => {
    const f = await fixture(); const generation = await f.generation();
    const sidecar = await f.readSidecar();
    await expect(f.reads.markVisible("dev", SPARK_SESSION_ID, [2], generation, [{ id: 2, createdAt: 1200, requestId: "r" }]))
      .rejects.toThrow("visible_message_receipt_stale");
    await expect(f.reads.markVisible("dev", SPARK_SESSION_ID, [4], generation, [{ id: 4, createdAt: 1400, requestId: "other" }]))
      .rejects.toThrow("visible_message_receipt_stale");
    expect(await f.readSidecar()).toBe(sidecar);
    expect(await f.reads.assistantReadEvidence("dev", SPARK_SESSION_ID)).toEqual({ status: "available", messages: [
      { messageId: "4", createdAt: 1400, requestId: "r", readAt: null },
      { messageId: "5", createdAt: 1500, requestId: "later", readAt: null },
    ] });
  });

  test("historical approval receipts survive projection and subsequent visible reads", async () => {
    const f = await fixture(); const generation = await f.generation();
    const directory = join(f.root, "dev", "web-ui", "read-state");
    const [filename] = await readdir(directory);
    const path = join(directory, filename!);
    const state = JSON.parse(await f.readSidecar());
    const visible = state.visibleMessages.find(([id]: [string, unknown]) => id === SPARK_SESSION_ID)[1];
    visible.messages = [
      { messageId: "2", createdAt: 1200, requestId: "r" },
      { messageId: "4", createdAt: 1400, requestId: "r" },
    ];
    await writeFile(path, JSON.stringify(state));
    const before = await f.readSidecar();
    expect(await f.reads.project("dev", await f.snapshot({ identitiesOnly: true })))
      .toMatchObject({ unreadMessageIds: [5] });
    expect(await f.readSidecar()).toBe(before);
    await f.reads.markVisible("dev", SPARK_SESSION_ID, [5], generation, [{ id: 5, createdAt: 1500, requestId: "later" }]);
    const saved = JSON.parse(await f.readSidecar()).visibleMessages[0][1];
    expect(saved.generation).toBe(generation);
    expect(saved.messages).toEqual([...visible.messages, { messageId: "5", createdAt: 1500, requestId: "later" }]);
  });

  test("ordinary conversations retain their cumulative approval and reply read behavior", async () => {
    const f = await fixture();
    const { kind: _kind, ...record } = f.record;
    const sessions = f.environment("dev").services.sessions;
    await writeFile(join(f.root, "dev", "sessions", "ordinary.json"), JSON.stringify({ ...record, id: "ordinary" }));
    const snapshot = (await sessions.getSessionSnapshot("ordinary", { identitiesOnly: true }))!;
    expect(await f.reads.project("dev", snapshot)).toMatchObject({ unreadCount: 4 });
    expect(await f.reads.mark("dev", "ordinary", { readThroughMessageId: 4 })).toMatchObject({ unreadCount: 1 });
    const evidence = await f.reads.assistantReadEvidence("dev", "ordinary");
    expect(evidence.status).toBe("available");
    if (evidence.status !== "available") throw new Error("Missing evidence");
    expect(evidence.messages.map(({ messageId }) => messageId)).toEqual(["2", "3", "4", "5"]);
  });
});
