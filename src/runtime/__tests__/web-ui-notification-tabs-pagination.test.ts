import { describe, expect, test, vi } from "vitest";
import { ContextElement } from "./support/composer-context-window-dom.js";
// @ts-expect-error Browser component has no declaration surface.
import { createNotificationTabs } from "../../web-ui/app/components/notifications/tabs.js";
// @ts-expect-error Browser component has no declaration surface.
import { canLoadOlderNotifications } from "../../web-ui/app/components/notifications/pagination.js";
// @ts-expect-error Browser component has no declaration surface.
import { renderNotificationSettings } from "../../web-ui/app/components/notifications/presentation.js";
import { defaultNotificationPreferences } from "../../web-ui/notifications/contracts.js";

class NotificationElement extends ContextElement {
  inert = false;
  focus = vi.fn();
  matches(selector: string) {
    const attribute = selector.match(/^\[data-notification-(tab|panel)="([^"]+)"\]$/);
    if (!attribute) return super.matches(selector);
    const key = attribute[1] === "tab" ? "notificationTab" : "notificationPanel";
    return this.dataset[key] === attribute[2];
  }
}

function tabFixture() {
  const root = new NotificationElement("section");
  const inboxTab = new NotificationElement("button");
  const settingsTab = new NotificationElement("button");
  const inbox = new NotificationElement("div");
  const settings = new NotificationElement("div");
  inboxTab.dataset.notificationTab = "notifications";
  settingsTab.dataset.notificationTab = "settings";
  inbox.dataset.notificationPanel = "notifications";
  settings.dataset.notificationPanel = "settings";
  root.append(inboxTab, settingsTab, inbox, settings);
  return { root, inboxTab, settingsTab, inbox, settings };
}

describe("notification workspace tabs", () => {
  test("defaults to the inbox and makes only the selected panel interactive", () => {
    const f = tabFixture();
    const tabs = createNotificationTabs(f.root);
    expect(f.inboxTab.getAttribute("aria-selected")).toBe("true");
    expect(f.inboxTab.tabIndex).toBe(0);
    expect(f.settingsTab.tabIndex).toBe(-1);
    expect(f.inbox.hidden).toBe(false);
    expect(f.inbox.inert).toBe(false);
    expect(f.settings.hidden).toBe(true);
    expect(f.settings.inert).toBe(true);
    f.settingsTab.dispatch("click");
    expect(f.settingsTab.getAttribute("aria-selected")).toBe("true");
    expect(f.settingsTab.classList.contains("active")).toBe(true);
    expect(f.inboxTab.getAttribute("aria-selected")).toBe("false");
    expect(f.inboxTab.tabIndex).toBe(-1);
    expect(f.settingsTab.tabIndex).toBe(0);
    expect(f.settings.hidden).toBe(false);
    expect(f.settings.inert).toBe(false);
    expect(f.inbox.hidden).toBe(true);
    expect(f.inbox.inert).toBe(true);
    expect(tabs.activate("unknown")).toBe(false);
    expect(f.settings.hidden).toBe(false);
    expect(f.settingsTab.focus).not.toHaveBeenCalled();
  });

  test("keyboard selection wraps, supports Home and End, and moves focus", () => {
    const f = tabFixture();
    createNotificationTabs(f.root);
    const preventDefault = vi.fn();
    f.inboxTab.dispatch("keydown", { key: "ArrowLeft", preventDefault });
    expect(f.settingsTab.focus).toHaveBeenCalledOnce();
    expect(f.settings.hidden).toBe(false);
    f.settingsTab.dispatch("keydown", { key: "ArrowRight", preventDefault });
    expect(f.inboxTab.focus).toHaveBeenCalledOnce();
    expect(f.inbox.hidden).toBe(false);
    f.inboxTab.dispatch("keydown", { key: "End", preventDefault });
    expect(f.settings.hidden).toBe(false);
    f.settingsTab.dispatch("keydown", { key: "Home", preventDefault });
    expect(f.inbox.hidden).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(4);
    f.inboxTab.dispatch("keydown", { key: "Tab", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });

  test("settings are directly available without a second disclosure", () => {
    const html = renderNotificationSettings({
      preferences: defaultNotificationPreferences(), busy: false,
    });
    expect(html).toContain('data-notification-preference="desktopEnabled"');
    expect(html).toContain('data-notification-kind="reply"');
    expect(html).not.toMatch(/<(details|summary)\b/);
  });
});

describe("notification history pagination", () => {
  const unread = { readAt: null };
  const read = { readAt: 1 };
  const snapshot = { filter: "unread", nextCursor: "opaque:older", unreadCount: 0, items: [] };

  test("hides read history when no unread notifications remain", () => {
    expect(canLoadOlderNotifications({ ...snapshot, items: [read] })).toBe(false);
  });

  test("hides paging once every unread item is already loaded", () => {
    expect(canLoadOlderNotifications({ ...snapshot, unreadCount: 2, items: [unread, read, unread] })).toBe(false);
  });

  test("retains access to unread notifications beyond the current pages", () => {
    expect(canLoadOlderNotifications({ ...snapshot, unreadCount: 2, items: [unread, read] })).toBe(true);
    expect(canLoadOlderNotifications({ ...snapshot, unreadCount: 2, items: [read] })).toBe(true);
    expect(canLoadOlderNotifications({ ...snapshot, unreadCount: 2, nextCursor: null })).toBe(false);
  });

  test("All pages through older read history whenever a cursor exists", () => {
    expect(canLoadOlderNotifications({ ...snapshot, filter: "all", items: [read] })).toBe(true);
    expect(canLoadOlderNotifications({ ...snapshot, filter: "all", nextCursor: null })).toBe(false);
  });
});
