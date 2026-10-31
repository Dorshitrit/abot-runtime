import { afterEach, describe, expect, test, vi } from "vitest";
import { createNotificationFavicon } from "../../web-ui/app/components/notifications/favicon.js";
// @ts-expect-error Browser-only controller.
import { createNotificationsController } from "../../web-ui/app/controllers/notifications-controller.js";

function faviconFixture(originalHref = "/favicon.svg") {
  const attributes = new Map([["href", originalHref]]);
  const icon = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
  };
  const documentRoot = { querySelector: vi.fn(() => icon) } as unknown as Document;
  return { favicon: createNotificationFavicon({ documentRoot }), icon, href: () => attributes.get("href") };
}

function controllerFixture() {
  const f = faviconFixture();
  let environment = "prod";
  let visible = false;
  let unreadCount = 0;
  const client = {
    supportsNotifications: () => true,
    listNotifications: vi.fn(async (_environment: string, _options: unknown) => ({ items: [], unreadCount })),
    markNotificationsRead: vi.fn(async () => { unreadCount = 0; }),
  };
  const controller = createNotificationsController({
    client, getEnvironmentId: () => environment, isVisible: () => visible,
    render: f.favicon.render,
  });
  return {
    ...f, client, controller,
    unread: (count: number) => { unreadCount = count; },
    visibility: (value: boolean) => { visible = value; controller.visibilityChanged(); },
    environment: (value: string) => { environment = value; controller.environmentChanged(); },
    changed: (value = environment) => controller.handleRealtime({
      type: "workspace_changed", environment: value, resources: ["notifications"],
    }),
  };
}

afterEach(() => vi.useRealTimers());

describe("notification tab favicon", () => {
  test("switches only for supported unread notification count and restores the original icon", () => {
    const f = faviconFixture("/favicon.svg?original");
    f.favicon.render({ supported: true, unreadCount: 2 });
    expect(f.href()).toBe("/favicon-unread.svg");
    f.favicon.render({ supported: true, unreadCount: 5 });
    expect(f.icon.setAttribute).toHaveBeenCalledOnce();
    f.favicon.render({ supported: true, unreadCount: 0 });
    expect(f.href()).toBe("/favicon.svg?original");
    f.favicon.render({ supported: true, unreadCount: 1 });
    f.favicon.render({ supported: false, unreadCount: 1 });
    expect(f.href()).toBe("/favicon.svg?original");
    for (const unreadCount of [-1, 1.2, Number.NaN]) {
      f.favicon.render({ supported: true, unreadCount });
      expect(f.href()).toBe("/favicon.svg?original");
    }
  });

  test("is inert when the document has no tab icon", () => {
    const documentRoot = { querySelector: () => null } as unknown as Document;
    const f = createNotificationFavicon({ documentRoot });
    expect(() => f.render({ supported: true, unreadCount: 1 })).not.toThrow();
  });

  test("updates while hidden, coalesces relevant events and clears when read elsewhere", async () => {
    vi.useFakeTimers();
    const f = controllerFixture();
    f.changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listNotifications).not.toHaveBeenCalled();
    await f.controller.setReady();
    expect(f.href()).toBe("/favicon.svg");
    f.unread(3);
    f.changed("other");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listNotifications).toHaveBeenCalledOnce();
    f.changed(); f.changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.client.listNotifications).toHaveBeenCalledTimes(2);
    expect(f.href()).toBe("/favicon-unread.svg");
    expect(f.client.markNotificationsRead).not.toHaveBeenCalled();
    f.unread(0);
    f.changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.href()).toBe("/favicon.svg");
    f.controller.dispose();
  });

  test("keeps a queued refresh when the tab becomes hidden, and focus does not mark read", async () => {
    vi.useFakeTimers();
    const f = controllerFixture();
    await f.controller.setReady();
    f.visibility(true);
    await vi.advanceTimersByTimeAsync(0);
    f.unread(1);
    f.changed();
    f.visibility(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.href()).toBe("/favicon-unread.svg");
    f.visibility(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.href()).toBe("/favicon-unread.svg");
    expect(f.client.markNotificationsRead).not.toHaveBeenCalled();
    await f.controller.markAllRead();
    expect(f.href()).toBe("/favicon.svg");
    f.controller.dispose();
  });

  test("resets immediately on environment change and rejects an older count", async () => {
    const f = controllerFixture();
    f.unread(2);
    await f.controller.setReady();
    expect(f.href()).toBe("/favicon-unread.svg");
    let resolve!: (value: { items: []; unreadCount: number }) => void;
    f.client.listNotifications.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const oldRead = f.controller.refresh();
    f.unread(0);
    f.environment("dev");
    expect(f.href()).toBe("/favicon.svg");
    await f.controller.refresh();
    resolve({ items: [], unreadCount: 8 });
    await oldRead;
    expect(f.href()).toBe("/favicon.svg");
    f.controller.dispose();
  });
});
