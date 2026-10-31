import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  defaultNotificationPreferences,
  type WebNotification,
} from "../../web-ui/notifications/contracts.js";
import {
  notificationStorePath,
  WebNotificationStore,
} from "../../web-ui/notifications/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "web-notifications-"));
  roots.push(root);
  const path = notificationStorePath({
    runtimeDir: root,
    sessionsDir: join(root, "sessions"),
    environmentId: "dev",
  });
  return { root, path, store: new WebNotificationStore(path, "dev", { now: () => 5000 }) };
}

function notification(id: string, createdAt = 1000): WebNotification {
  return {
    id,
    kind: "reply",
    title: "ABot replied",
    body: "A useful response",
    createdAt,
    readAt: null,
    environmentId: "dev",
    sessionId: "chat",
    requestId: `request-${id}`,
    sourceUrl: "/chat?environment=dev&session=chat",
    delivery: { status: "pending" },
  };
}

function automationNotification(id: string): WebNotification {
  return {
    id,
    kind: "automation",
    title: "Automation completed",
    body: "The run completed",
    createdAt: 1000,
    readAt: null,
    environmentId: "dev",
    automationId: "flow-a",
    runId: "run-a",
    sourceUrl: "/automations?environment=dev&automation=flow-a&run=run-a",
    delivery: { status: "pending" },
  };
}

describe("persistent Web UI notification history", () => {
  test("reads v1 preferences without an automation setting as enabled", async () => {
    const { path, store } = await fixture();
    const legacyPreferences = {
      desktopEnabled: false,
      kinds: { reply: false, failure: true, approval: false, proposal: true },
    };
    await store.initialize();
    await writeFile(path, JSON.stringify({
      version: 1, environmentId: "dev", items: [], preferences: legacyPreferences,
    }));
    expect(await store.getPreferences()).toEqual({
      desktopEnabled: false,
      kinds: { ...legacyPreferences.kinds, automation: true },
    });
    await store.setPreferences({
      desktopEnabled: false,
      kinds: { ...legacyPreferences.kinds, automation: false },
    });
    expect(JSON.parse(await readFile(path, "utf8")).preferences.kinds.automation)
      .toBe(false);
  });

  test("accepts only automation links bound to the stored automation and run", async () => {
    const { store } = await fixture();
    const item = automationNotification("automation-run-a");
    expect((await store.upsert(item)).created).toBe(true);
    const invalid = [
      { ...item, automationId: "other" },
      { ...item, runId: "other" },
      { ...item, sessionId: "fake-session" },
      { ...item, requestId: "fake-request" },
      { ...item, sourceUrl: "/automations?environment=dev&run=run-a" },
      { ...item, sourceUrl: "/automations?environment=dev&automation=flow-a" },
      { ...item, sourceUrl: "/automations?environment=prod&automation=flow-a&run=run-a" },
      { ...item, sourceUrl: "/automations?environment=dev&automation=flow-a&run=run-a&extra=1" },
      { ...item, sourceUrl: "/automations?environment=dev&automation=flow-a&run=run-a&run=run-a" },
      { ...item, sourceUrl: "/automations?environment=dev&automation=flow-a&run=run-a#details" },
      { ...item, sourceUrl: "//elsewhere.test/automations?environment=dev&automation=flow-a&run=run-a" },
      { ...notification("reply-a"), automationId: "flow-a" },
      { ...notification("reply-a"), sourceUrl: item.sourceUrl },
    ];
    for (const malformed of invalid)
      expect(() => store.upsert(malformed as WebNotification)).toThrow(
        "Invalid notification",
      );
  });

  test("deduplicates by identity across restart without resetting read or delivery state", async () => {
    const { path, store } = await fixture();
    expect((await store.upsert(notification("reply-1"))).created).toBe(true);
    await store.markRead({ ids: ["reply-1"], read: true }, 2000);
    await store.updateDelivery("reply-1", { status: "submitted" });
    const restarted = new WebNotificationStore(path, "dev", { now: () => 5000 });
    const duplicate = await restarted.upsert({
      ...notification("reply-1"),
      body: "Replayed event",
    });
    expect(duplicate).toMatchObject({
      created: false,
      item: {
        body: "A useful response",
        readAt: 2000,
        delivery: { status: "submitted" },
      },
    });
    expect(await restarted.list()).toMatchObject({
      items: [duplicate.item],
      unreadCount: 0,
      nextCursor: null,
    });
  });

  test("serializes independent store instances without losing concurrent insertions or preferences", async () => {
    const { path, store } = await fixture();
    const other = new WebNotificationStore(path, "dev", { now: () => 5000 });
    const preferences = {
      ...defaultNotificationPreferences(),
      desktopEnabled: false,
    };
    await Promise.all([
      ...Array.from({ length: 60 }, (_, index) =>
        (index % 2 ? store : other).upsert(
          notification(`reply-${index}`, 1000 + index),
        ),
      ),
      other.setPreferences(preferences),
    ]);
    const page = await store.list({ limit: 100 });
    expect(page.items).toHaveLength(60);
    expect(page.unreadCount).toBe(60);
    expect(page.preferences).toEqual(preferences);
    expect(
      await new WebNotificationStore(path, "dev", { now: () => 5000 }).getPreferences(),
    ).toEqual(preferences);
  });

  test("paginates newest first without repeating ties or new arrivals between pages", async () => {
    const { store } = await fixture();
    for (const id of ["a", "c", "b"]) await store.upsert(notification(id));
    await store.upsert(notification("older", 900));
    const first = await store.list({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["c", "b"]);
    await store.upsert(notification("new", 2000));
    const second = await store.list({ limit: 2, before: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["a", "older"]);
    expect(second.nextCursor).toBeNull();
    expect(second.unreadCount).toBe(5);
  });

  test("keeps disabled kinds in history and supports explicit read, unread, and read all", async () => {
    const { store } = await fixture();
    const preferences = defaultNotificationPreferences();
    preferences.kinds.reply = false;
    await store.setPreferences(preferences);
    await store.upsert(notification("a"));
    await store.upsert(notification("b"));
    expect(
      await store.markRead({ ids: ["a", "unknown"], read: true }, 2000),
    ).toEqual({ updated: 1, unreadCount: 1 });
    expect(await store.markRead({ ids: ["a"], read: true }, 3000)).toEqual({
      updated: 0,
      unreadCount: 1,
    });
    expect(
      (await store.list()).items.find((item) => item.id === "a")?.readAt,
    ).toBe(2000);
    expect(await store.markRead({ ids: ["a"], read: false })).toEqual({
      updated: 1,
      unreadCount: 2,
    });
    expect(await store.markRead({ all: true, read: true }, 4000)).toEqual({
      updated: 2,
      unreadCount: 0,
    });
    expect((await store.list()).items).toHaveLength(2);
  });

  test("isolates environments and session roots and rejects cross-environment cursors", async () => {
    const { root, path, store } = await fixture();
    const productionPath = notificationStorePath({
      runtimeDir: root,
      sessionsDir: join(root, "sessions"),
      environmentId: "prod",
    });
    const movedPath = notificationStorePath({
      runtimeDir: root,
      sessionsDir: join(root, "different"),
      environmentId: "dev",
    });
    expect(new Set([path, productionPath, movedPath]).size).toBe(3);
    await store.upsert(notification("a"));
    await store.upsert(notification("b"));
    const cursor = (await store.list({ limit: 1 })).nextCursor!;
    const production = new WebNotificationStore(productionPath, "prod", { now: () => 5000 });
    expect(() => production.list({ before: cursor })).toThrow(
      "another environment",
    );
    expect((await production.list()).items).toEqual([]);
    expect(
      (await new WebNotificationStore(movedPath, "dev", { now: () => 5000 }).list()).items,
    ).toEqual([]);
    await expect(new WebNotificationStore(path, "prod", { now: () => 5000 }).list()).rejects.toThrow(
      "environment mismatch",
    );
  });

  test("returns snapshots that cannot mutate persisted state and saves private files", async () => {
    const { path, store } = await fixture();
    const item = notification("a");
    const pending = store.upsert(item);
    item.body = "changed while waiting";
    const result = await pending;
    result.item.body = "changed returned value";
    const page = await store.list();
    page.preferences.desktopEnabled = false;
    expect((await store.list()).items[0].body).toBe("A useful response");
    expect((await store.getPreferences()).desktopEnabled).toBe(true);
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("preserves corrupt state and rejects unsafe source addresses and invalid limits", async () => {
    const { path, store } = await fixture();
    for (const sourceUrl of [
      "https://other.test/chat",
      "//other.test/chat",
      "/chat?environment=prod&session=chat",
      "/chat?environment=dev&session=other",
      "/chat?environment=dev&session=chat&redirect=https://other.test",
    ]) {
      expect(() => store.upsert({ ...notification("a"), sourceUrl })).toThrow(
        "Invalid notification",
      );
    }
    for (const limit of [0, 101, 1.5, NaN])
      expect(() => store.list({ limit })).toThrow("limit");
    expect(() => store.list({ before: "bad" })).toThrow("cursor");
    await store.initialize();
    const corrupt = "{invalid";
    await writeFile(path, corrupt);
    await expect(store.upsert(notification("b"))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });
});
