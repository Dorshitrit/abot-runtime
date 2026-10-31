import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultNotificationPreferences, type WebNotification } from "../../web-ui/notifications/contracts.js";
import { NOTIFICATION_RETENTION_MS } from "../../web-ui/notifications/retention.js";
import type { NotificationStoreState } from "../../web-ui/notifications/storage-schema.js";
import { WebNotificationStore } from "../../web-ui/notifications/store.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 120 * DAY;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function reply(id: string, patch: Partial<WebNotification> = {}): WebNotification {
  return {
    id, kind: "reply", title: "Reply ready", body: "The requested result.", createdAt: NOW - DAY,
    readAt: null, environmentId: "dev", sessionId: "chat", requestId: `request-${id}`,
    sourceUrl: "/chat?environment=dev&session=chat", delivery: { status: "pending" }, ...patch,
  } as WebNotification;
}

async function fixture(items: WebNotification[] = [], metadata: Partial<NotificationStoreState> = {}) {
  const artifacts = join(process.cwd(), ".codex/artifacts/notification-read-retention-20261028");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "store-"));
  roots.push(root);
  const path = join(root, "notifications.json");
  let now = NOW;
  const pruned = vi.fn();
  const options = { now: () => now, onPruned: pruned };
  const seed: NotificationStoreState = {
    version: 1, environmentId: "dev", items, preferences: defaultNotificationPreferences(),
    readSyncInitialized: true, ...metadata,
  };
  await writeFile(path, JSON.stringify(seed));
  return {
    path, pruned, store: new WebNotificationStore(path, "dev", options),
    restart: () => new WebNotificationStore(path, "dev", options),
    time: (value: number) => { now = value; },
    saved: async () => JSON.parse(await readFile(path, "utf8")) as NotificationStoreState,
  };
}

const manyReplies = (count: number) => Array.from({ length: count }, (_, index) =>
  reply(`reply-${String(index).padStart(4, "0")}`, { createdAt: NOW - DAY + index }));

describe("bounded notification history", () => {
  test("expires read and unread records at exactly 90 days on the first read and persists the cleanup", async () => {
    const cutoff = NOW - NOTIFICATION_RETENTION_MS;
    const f = await fixture([
      reply("expired-read", { createdAt: cutoff - 1, readAt: cutoff }),
      reply("expired-unread", { createdAt: cutoff }),
      reply("retained", { createdAt: cutoff + 1 }),
    ]);
    expect(await f.store.list()).toMatchObject({ items: [{ id: "retained" }], unreadCount: 1 });
    expect((await f.saved()).items.map((item) => item.id)).toEqual(["retained"]);
    expect(f.pruned).toHaveBeenCalledOnce();
    expect((await f.restart().list()).items).toHaveLength(1);
    expect(f.pruned).toHaveBeenCalledOnce();
  });

  test("evicts read items before older unread items and includes pending delivery records", async () => {
    const items = manyReplies(1001);
    items[1000].readAt = NOW;
    const f = await fixture(items);
    const page = await f.store.list();
    expect(page.items).toHaveLength(50);
    expect(page.unreadCount).toBe(1000);
    expect(await f.store.get(items[0].id)).toMatchObject({ delivery: { status: "pending" } });
    expect(await f.store.get(items[1000].id)).toBeNull();
    expect((await f.saved()).items).toHaveLength(1000);
  });

  test.each([false, true])("caps all unread/read history at 1000 with stable oldest-first eviction (read=%s)", async (read) => {
    const items = manyReplies(1001).map((item) => ({ ...item, createdAt: NOW - DAY, readAt: read ? NOW : null }));
    const f = await fixture(items);
    expect(await f.store.get("reply-0000")).toBeNull();
    expect(await f.store.get("reply-1000")).not.toBeNull();
    expect((await f.saved()).items).toHaveLength(1000);
    expect((await f.store.list()).unreadCount).toBe(read ? 0 : 1000);
  });

  test("enforces the cap before reporting insertion and rejects an immediately evicted read arrival", async () => {
    const f = await fixture(manyReplies(1000));
    expect(await f.store.upsert(reply("read-arrival", { createdAt: NOW, readAt: NOW })))
      .toMatchObject({ created: false });
    expect(await f.store.get("read-arrival")).toBeNull();
    expect(await f.store.upsert(reply("unread-arrival", { createdAt: NOW }))).toMatchObject({ created: true });
    expect((await f.saved()).items).toHaveLength(1000);
    expect(await f.store.get("reply-0000")).toBeNull();
    expect(f.pruned).toHaveBeenCalledOnce();
  });

  test("a queued delivery cannot find or recreate an expired notification", async () => {
    const f = await fixture([reply("queued")]);
    f.time(NOW + NOTIFICATION_RETENTION_MS);
    expect(await f.store.get("queued")).toBeNull();
    expect(await f.store.updateDelivery("queued", { status: "submitted" })).toBe(false);
    expect((await f.saved()).items).toEqual([]);
  });

  test("remembers evicted identities through restart without renewing their bounded receipt on replay", async () => {
    const f = await fixture([reply("reply-0000", { createdAt: NOW - NOTIFICATION_RETENTION_MS })]);
    await f.store.initialize();
    const retiredAt = (await f.saved()).tombstones![0].retiredAt;
    f.time(NOW + NOTIFICATION_RETENTION_MS - 1);
    const replay = reply("reply-0000", { createdAt: NOW + NOTIFICATION_RETENTION_MS - 1 });
    expect((await f.restart().upsert(replay)).created).toBe(false);
    expect((await f.saved()).tombstones!.find((item) => item.id === replay.id)?.retiredAt).toBe(retiredAt);
    f.time(NOW + NOTIFICATION_RETENTION_MS);
    expect((await f.restart().upsert({ ...replay, createdAt: NOW + NOTIFICATION_RETENTION_MS })).created).toBe(true);
  });

  test("caps tombstones at 1000 and expires their metadata after 90 days", async () => {
    const f = await fixture(manyReplies(1200).map((item) => ({ ...item, createdAt: NOW - NOTIFICATION_RETENTION_MS })));
    await f.store.initialize();
    const saved = await f.saved();
    expect(saved.items).toHaveLength(0);
    expect(saved.tombstones).toHaveLength(1000);
    expect(new Set(saved.tombstones!.map((item) => item.id)).size).toBe(1000);
    f.time(NOW + NOTIFICATION_RETENTION_MS);
    await f.store.list();
    expect((await f.saved()).tombstones).toEqual([]);
  });

  test("cursor paging survives eviction of its boundary without repeating retained rows", async () => {
    const f = await fixture(manyReplies(1000));
    const first = await f.store.list({ limit: 2 });
    const boundary = first.items[1];
    await f.store.markRead({ ids: [boundary.id], read: true });
    await f.store.upsert(reply("latest", { createdAt: NOW }));
    const second = await f.store.list({ limit: 2, before: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["reply-0997", "reply-0996"]);
    expect(await f.store.get(boundary.id)).toBeNull();
  });
});

describe("private manual-unread authority", () => {
  test("preserves explicit unread even when already unread, across stores and automatic reconciliation", async () => {
    const f = await fixture([reply("manual"), reply("automatic")]);
    expect(await f.store.markRead({ ids: ["manual"], read: false })).toMatchObject({ updated: 0 });
    const restarted = f.restart();
    expect((await restarted.getUnreadReplies()).map((item) => item.id)).toEqual(["automatic"]);
    expect(await restarted.markRepliesRead(["manual", "automatic"]))
      .toEqual({ updated: 1, unreadCount: 1 });
    expect(await restarted.get("manual")).toMatchObject({ readAt: null });
    expect(await restarted.get("automatic")).toMatchObject({ readAt: NOW });
    expect((await restarted.list()).items.every((item) => !("manualUnreadIds" in item))).toBe(true);
    await restarted.markRead({ all: true, read: true });
    expect((await f.saved()).manualUnreadIds).toEqual([]);
  });

  test("automatic reading accepts only retained replies and respects session candidate selection", async () => {
    const f = await fixture([
      reply("reply"), reply("failure", { kind: "failure" }), reply("approval", { kind: "approval" }),
      reply("proposal", { kind: "proposal" }),
      reply("other", { sessionId: "other", sourceUrl: "/chat?environment=dev&session=other" }),
    ]);
    expect((await f.store.getUnreadReplies("chat")).map((item) => item.id)).toEqual(["reply"]);
    expect(await f.store.markRepliesRead(["reply", "failure", "approval", "proposal", "missing"]))
      .toEqual({ updated: 1, unreadCount: 4 });
    expect(await f.store.get("approval")).toMatchObject({ readAt: null });
  });

  test("manual and automatic updates serialize across independent store instances", async () => {
    const f = await fixture([reply("manual")]);
    await Promise.all([
      f.store.markRead({ ids: ["manual"], read: false }),
      f.restart().markRepliesRead(["manual"]),
    ]);
    expect(await f.store.get("manual")).toMatchObject({ readAt: null });
  });

  test("prunes overrides with retained history and never exposes private metadata in HTTP page shape", async () => {
    const f = await fixture([reply("expired", { createdAt: 0 }), reply("live")], {
      manualUnreadIds: ["expired", "live", "missing"],
    });
    const page = await f.store.list();
    expect((await f.saved()).manualUnreadIds).toEqual(["live"]);
    expect(Object.keys(page).sort()).toEqual(["items", "nextCursor", "preferences", "unreadCount"]);
  });

  test("an explicit read clears its override independently of automatic reading", async () => {
    const f = await fixture([reply("manual")]);
    await f.store.markRead({ ids: ["manual"], read: false });
    expect((await f.saved()).manualUnreadIds).toEqual(["manual"]);
    await f.store.markRead({ ids: ["manual"], read: true });
    expect((await f.saved()).manualUnreadIds).toEqual([]);
    expect(await f.store.get("manual")).toMatchObject({ readAt: NOW });
  });

  test.each([
    { manualUnreadIds: Array.from({ length: 1001 }, (_, index) => `id-${index}`) },
    { manualUnreadIds: ["duplicate", "duplicate"] },
    { tombstones: [{ id: "invalid", retiredAt: -1 }] },
    { tombstones: Array.from({ length: 1001 }, (_, index) => ({ id: `id-${index}`, retiredAt: NOW })) },
    { readSyncInitialized: false },
  ])("rejects invalid or unbounded private metadata without replacing saved evidence: %j", async (metadata) => {
    const f = await fixture([reply("retained")], metadata as Partial<NotificationStoreState>);
    const before = await readFile(f.path, "utf8");
    await expect(f.store.list()).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(before);
  });

  test("preserves every legacy unread record while leaving legacy read values unchanged", async () => {
    const legacyReadAt = NOW - DAY;
    const f = await fixture([
      reply("legacy-unread"), reply("legacy-approval", { kind: "approval" }),
      reply("legacy-read", { readAt: legacyReadAt }),
    ], { readSyncInitialized: undefined });
    await f.store.initialize();
    const saved = await f.saved();
    expect(saved.readSyncInitialized).toBe(true);
    expect(saved.manualUnreadIds).toEqual(["legacy-unread", "legacy-approval"]);
    expect(await f.store.markRepliesRead(["legacy-unread", "legacy-read"]))
      .toEqual({ updated: 0, unreadCount: 2 });
    expect(await f.store.get("legacy-read")).toMatchObject({ readAt: legacyReadAt });
    expect(await f.store.get("legacy-unread")).toMatchObject({ readAt: null });
  });

  test("new notifications stay eligible after legacy capture and restart never captures them again", async () => {
    const f = await fixture([reply("legacy")], { readSyncInitialized: undefined });
    await f.store.upsert(reply("new"));
    const restarted = f.restart();
    expect((await restarted.getUnreadReplies()).map((item) => item.id)).toEqual(["new"]);
    expect(await restarted.markRepliesRead(["legacy", "new"]))
      .toEqual({ updated: 1, unreadCount: 1 });
    expect((await f.saved()).manualUnreadIds).toEqual(["legacy"]);
    expect(await restarted.get("legacy")).toMatchObject({ readAt: null });
  });

  test("migration follows retention so both legacy overrides and items remain bounded", async () => {
    const f = await fixture(manyReplies(1001), { readSyncInitialized: undefined });
    await f.store.initialize();
    const saved = await f.saved();
    expect(saved.items).toHaveLength(1000);
    expect(saved.manualUnreadIds).toHaveLength(1000);
    expect(saved.manualUnreadIds).not.toContain("reply-0000");
    expect(new Set(saved.manualUnreadIds)).toEqual(new Set(saved.items.map((item) => item.id)));
  });

  test("an empty legacy store is initialized before its first new arrival", async () => {
    const f = await fixture([], { readSyncInitialized: undefined });
    await f.store.upsert(reply("first-new"));
    expect((await f.saved()).readSyncInitialized).toBe(true);
    expect((await f.saved()).manualUnreadIds).toEqual([]);
    expect(await f.store.markRepliesRead(["first-new"])).toEqual({ updated: 1, unreadCount: 0 });
  });

  test("new stores begin initialized without legacy unread overrides", async () => {
    const f = await fixture();
    const emptyPath = f.path + ".new";
    const fresh = new WebNotificationStore(emptyPath, "dev", { now: () => NOW });
    await fresh.upsert(reply("new"));
    expect(JSON.parse(await readFile(emptyPath, "utf8")).readSyncInitialized).toBe(true);
    expect((await fresh.getUnreadReplies()).map((item) => item.id)).toEqual(["new"]);
  });
});
