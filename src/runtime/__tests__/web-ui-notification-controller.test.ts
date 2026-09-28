import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser module has no declaration surface.
import { createNotificationsController } from "../../web-ui/app/controllers/notifications-controller.js";

function item(environmentId = "prod", id = "notice-1") {
  return { id, environmentId, readAt: null, kind: "reply", title: "A reply", body: "Hello", createdAt: 1 };
}
function result(environment = "prod") {
  return {
    items: [item(environment)], unreadCount: 1, nextCursor: null as string | null,
    preferences: { desktopEnabled: true, kinds: { reply: true, failure: true, approval: true, proposal: true } },
    desktop: { available: true },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
function fixture() {
  let environment = "prod";
  const client = {
    supportsNotifications: () => true,
    listNotifications: vi.fn(async (_environment: string, _page: unknown) => result(environment)),
    markNotificationsRead: vi.fn(async (_input: unknown, _environment: string) => ({})),
    saveNotificationPreferences: vi.fn(async (_input: unknown, _environment: string) => ({})),
  };
  const controller = createNotificationsController({
    client, getEnvironmentId: () => environment, render: vi.fn(), isVisible: () => true,
  });
  return { client, controller, setEnvironment: (next: string) => {
    environment = next; controller.environmentChanged();
  } };
}

afterEach(() => vi.useRealTimers());

describe("notification history controller", () => {
  test("coalesces relevant events and ignores other environment history", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.setReady();
    f.controller.handleRealtime({ type: "workspace_changed", environment: "other", resources: ["notifications"] });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listNotifications).toHaveBeenCalledOnce();
    f.controller.handleRealtime({ type: "workspace_changed", environment: "prod", resources: ["notifications"] });
    f.controller.handleRealtime({ type: "workspace_changed", environment: "prod", resources: ["notifications"] });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listNotifications).toHaveBeenCalledTimes(2);
    f.controller.handleRealtime({ type: "system-host.changed" });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listNotifications).toHaveBeenCalledTimes(3);
    f.controller.dispose();
  });
  test("marks the exact notification scope without loading or reading a conversation", async () => {
    const f = fixture();
    await f.controller.setReady();
    expect(f.controller.snapshot().items).toEqual([item()]);
    expect(await f.controller.markRead("notice-1", false)).toBe(true);
    expect(f.client.markNotificationsRead).toHaveBeenCalledWith({ ids: ["notice-1"], read: false }, "prod");
    expect(await f.controller.markRead("missing")).toBe(false);
    await f.controller.markAllRead();
    expect(f.client.markNotificationsRead).toHaveBeenLastCalledWith({ all: true, read: true }, "prod");
  });

  test("late history reads cannot replace the new environment", async () => {
    const f = fixture();
    await f.controller.setReady();
    const old = deferred<ReturnType<typeof result>>();
    f.client.listNotifications.mockReturnValueOnce(old.promise);
    const pending = f.controller.refresh();
    f.setEnvironment("dev");
    await f.controller.refresh();
    old.resolve(result("prod"));
    await pending;
    expect(f.controller.snapshot().items).toEqual([item("dev")]);
  });

  test("late mutations and errors cannot affect the new environment", async () => {
    const f = fixture();
    await f.controller.setReady();
    const old = deferred<object>();
    f.client.markNotificationsRead.mockReturnValueOnce(old.promise);
    const pending = f.controller.markRead("notice-1");
    expect(await f.controller.markRead("notice-1")).toBe(false);
    f.setEnvironment("dev");
    await f.controller.refresh();
    old.reject(new Error("Old failure"));
    expect(await pending).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ error: "", busy: false, items: [item("dev")] });
  });

  test("a completed read cannot navigate back after environment changes during its refresh", async () => {
    const f = fixture();
    await f.controller.setReady();
    const old = deferred<ReturnType<typeof result>>();
    f.client.listNotifications.mockReturnValueOnce(old.promise);
    const pending = f.controller.markRead("notice-1");
    await Promise.resolve();
    f.setEnvironment("dev");
    await f.controller.refresh();
    old.resolve(result("prod"));
    expect(await pending).toBe(false);
    expect(f.controller.snapshot().items).toEqual([item("dev")]);
  });

  test("rejects a mismatched environment list and preserves visible history", async () => {
    const f = fixture();
    await f.controller.setReady();
    f.client.listNotifications.mockResolvedValueOnce(result("other"));
    await f.controller.refresh();
    expect(f.controller.snapshot().items).toEqual([item()]);
    expect(f.controller.snapshot().error).toContain("could not be verified");
  });

  test("passes the opaque cursor and merges old pages without duplicates", async () => {
    const f = fixture();
    f.client.listNotifications.mockResolvedValueOnce({ ...result(), nextCursor: "opaque:page" } as ReturnType<typeof result>);
    await f.controller.setReady();
    f.client.listNotifications.mockResolvedValueOnce({ ...result(), items: [item(), item("prod", "older")] });
    await f.controller.loadMore();
    expect(f.client.listNotifications).toHaveBeenLastCalledWith("prod", { before: "opaque:page" });
    expect(f.controller.snapshot().items.map((entry: { id: string }) => entry.id)).toEqual(["notice-1", "older"]);
  });
});
