import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderNotificationItem, notificationSourceUrl } from "../../web-ui/app/components/notifications/presentation.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createNotificationFocus } from "../../web-ui/app/components/notifications/focus.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { notificationFeedback } from "../../web-ui/app/components/notifications/workspace.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import { readWorkspaceRoute, workspaceRouteUrl } from "../../web-ui/app/lib/workspace-route.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

const notice = {
  id: "notice-1", kind: "reply", title: "<script>alert(1)</script>", body: "<img src=x onerror=alert(1)>",
  createdAt: 1, readAt: null, environmentId: "prod", sessionId: "chat-a",
  sourceUrl: "/chat?environment=prod&session=chat-a", delivery: { status: "submitted" },
};

describe("notification presentation and navigation", () => {
  test("renders stored text safely and distinguishes submitted from read", () => {
    const html = renderNotificationItem(notice, false);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Sent to computer");
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain("Mark read");
  });

  test("offers a compact preview with full details and separate accessible actions", () => {
    const body = "העדכון המלא זמין כאן גם כששורת התצוגה המקדימה קצרה.\nעוד מידע על הבקשה.";
    const html = renderNotificationItem({ ...notice, title: "עדכון חדש", body }, false);
    const summary = html.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
    expect(summary).toContain('class="notification-item-preview" dir="auto"');
    expect(summary).toContain(body);
    expect(summary).not.toMatch(/<(button|a)\b/);
    expect(html).toContain(`<p dir="auto">${body}</p>`);
    expect(html).toContain('aria-label="Mark read"');
    expect(html).toContain(`href="/chat?environment=prod&amp;session=chat-a"`);
    expect(html).not.toContain('<details class="notification-item-details" open');
  });

  test.each(["failed", "unknown", "unavailable"])("shows a safe %s delivery reason inside expanded details", (status) => {
    const reason = "<img src=x onerror=alert(1)> Desktop alerts are blocked.";
    const html = renderNotificationItem({ ...notice, delivery: { status, error: reason } }, false);
    const summary = html.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
    expect(summary).not.toContain("Desktop alerts are blocked.");
    expect(html).toContain('class="notification-delivery-error" dir="auto"');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Desktop alerts are blocked.");
    expect(html).not.toContain("<img");
  });

  test("omits empty and irrelevant delivery errors and hides legacy PowerShell serialization", () => {
    for (const status of ["pending", "submitted", "disabled"])
      expect(renderNotificationItem({ ...notice, delivery: { status, error: "stale failure" } }, false))
        .not.toContain("notification-delivery-error");
    for (const error of [undefined, "", "   "])
      expect(renderNotificationItem({ ...notice, delivery: { status: "failed", error } }, false))
        .not.toContain("notification-delivery-error");
    const html = renderNotificationItem({
      ...notice, delivery: { status: "failed", error: "#< CLIXML\n<Objs>serialized exception</Objs>" },
    }, false);
    expect(html).toContain("The computer returned an unreadable error.");
    expect(html).not.toContain("CLIXML");
    expect(html).not.toContain("serialized exception");
  });

  test("restores keyboard focus to the same disclosure after a notification refresh", () => {
    const previous = { dataset: { notificationDetail: notice.id } };
    const replacement = { dataset: { notificationDetail: notice.id }, focus: vi.fn() };
    const body = {};
    const ownerDocument = { activeElement: previous as object, body };
    const root = {
      ownerDocument,
      contains: (element: object) => element === previous || element === replacement,
      closest: () => null,
      querySelectorAll: () => [replacement],
      querySelector: () => null,
    };
    const focus = createNotificationFocus(root);
    focus.remember();
    ownerDocument.activeElement = body;
    focus.restore(false);
    expect(replacement.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("directs users to older unread history when the loaded page contains only read items", () => {
    const snapshot = {
      supported: true, filter: "unread", unreadCount: 1, nextCursor: "older-page",
      loading: false, error: "",
    };
    expect(notificationFeedback(snapshot, [])).toContain("Load older notifications");
    expect(notificationFeedback({ ...snapshot, loading: true }, [])).toBe("Loading notifications…");
    expect(notificationFeedback({ ...snapshot, unreadCount: 0 }, [])).toBe("You're all caught up.");
    expect(notificationFeedback(snapshot, [notice])).toBe("");
  });

  test("source links must remain inside the same environment and allowed workspace", () => {
    expect(notificationSourceUrl(notice)).toBe(notice.sourceUrl);
    for (const sourceUrl of ["https://elsewhere.invalid/", "//elsewhere.invalid/", "//[", "/chat?environment=dev", "/web-api/notifications?environment=prod"])
      expect(notificationSourceUrl({ ...notice, sourceUrl })).toBe("");
    expect(notificationSourceUrl({ ...notice, sourceUrl: "/notifications?environment=prod" })).toContain("/notifications");
  });

  test("restores notifications routes and honors the configuration discard guard", () => {
    expect(readWorkspaceRoute({ pathname: "/notifications", search: "?environment=dev" })).toMatchObject({
      workspace: "notifications", environment: "dev",
    });
    expect(workspaceRouteUrl({ workspace: "notifications", environment: "dev" })).toBe("/notifications?environment=dev");
    const harness = createWorkspaceShellHarness(390);
    let mayLeave = false;
    const shell = createWorkspaceShell({
      ...harness, beforeWorkspaceChange: ({ from }: { from: string }) => from !== "config" || mayLeave,
    });
    shell.bind();
    shell.load();
    shell.activateWorkspace("config");
    expect(shell.activateWorkspace("notifications")).toBe(false);
    mayLeave = true;
    harness.dom.notificationsWorkspaceButton.dispatch("click");
    harness.flushFrames();
    expect(shell.activeWorkspace()).toBe("notifications");
    expect(harness.dom.notificationsWorkspacePanel.hidden).toBe(false);
    expect(harness.dom.chatPanel.hidden).toBe(true);
    expect(harness.documentRoot.activeElement).toBe(harness.dom.closeNotificationsWorkspaceButton);
    expect(harness.dom.notificationsWorkspaceButton.getAttribute("aria-current")).toBe("page");
    shell.closeOverlaysOnEscape();
    expect(harness.dom.notificationsWorkspacePanel.hidden).toBe(true);
  });

  test("client requests preserve explicit environment and opaque paging scope", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response("{}"));
    const client = createRuntimeWebClient({
      getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "fallback",
      fetchImpl: fetchImpl as typeof fetch, origin: "https://abot.invalid",
    });
    await client.listNotifications("env & one", { before: "opaque + cursor" });
    const requested = String(fetchImpl.mock.calls[0]?.[0]);
    const query = new URL(requested, "https://abot.invalid").searchParams;
    expect(query.get("environment")).toBe("env & one");
    expect(query.get("before")).toBe("opaque + cursor");
    await client.markNotificationsRead({ ids: ["notice-1"], read: true }, "prod");
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "POST", body: JSON.stringify({ ids: ["notice-1"], read: true, environment: "prod" }),
    });
    const unsupported = createRuntimeWebClient({
      getConfig: () => ({ backend: "bridge" }), getEnvironmentId: () => "prod",
      fetchImpl: fetchImpl as typeof fetch, origin: "https://abot.invalid",
    });
    expect(() => unsupported.listNotifications()).toThrow("unavailable");
  });
});
