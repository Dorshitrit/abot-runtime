import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createHomeWidgetCard } from "../../web-ui/app/components/dashboard/widget-card.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { dashboardWidgetSummaries } from "../../web-ui/app/components/dashboard/widget-summaries.js";
import { createHomeWidgetsHarness, type HomeWidgetElement } from "./support/home-widgets-harness.js";

function createCard(id = "conversations", label = "Conversations") {
  const harness = createHomeWidgetsHarness();
  const card = createHomeWidgetCard({ documentRoot: harness.documentRoot, id, label, icon: id });
  harness.root.append(card.button);
  return { ...harness, button: card.button as HomeWidgetElement, render: card.render as (summary: unknown) => void };
}

const sessions = [
  { id: "old", title: "Older unread chat", updatedAt: 1000, unreadCount: 7 },
  { id: "latest", title: "Latest chat", updatedAt: 3000, unreadCount: 2 },
  { id: "middle", title: "Previous chat", updatedAt: 2000, unreadCount: 0 },
];

describe("Home widget read-only previews", () => {
  test("escapes titles, details and accessible icon labels without creating active markup", () => {
    const h = createCard();
    const title = '<script>alert("title")</script>';
    const detail = '<img src=x onerror="alert(1)">';
    const label = '" onmouseover="alert(2)" <unsafe> & unread';
    h.render({ title, detail, preview: { kind: "rows", items: [
      { title, detail, indicator: { icon: "unread", label, tone: "active" } },
    ] } });
    expect(h.button.querySelector(".home-widget-item-title")?.textContent).toBe(title);
    expect(h.button.querySelector(".home-widget-meta")?.textContent).toBe(detail);
    expect(h.button.querySelector(".home-widget-item-title")?.attributes.get("title")).toBe(title);
    expect(h.button.querySelector('[role="img"]')?.attributes.get("aria-label")).toBe(label);
    expect(h.button.querySelector("script")).toBeNull();
    expect(h.button.querySelector("img")).toBeNull();
    expect(h.button.querySelector("[onmouseover]")).toBeNull();
    expect(h.button.attributes.get("aria-description")).toContain(label);
  });

  test("keeps the same focused button and activation listener while its preview changes", () => {
    const h = createCard();
    const activated = vi.fn();
    const summary = dashboardWidgetSummaries({ sessions }).conversations;
    h.button.addEventListener("click", activated);
    h.render(summary);
    h.button.focus();
    const firstRow = h.button.querySelector(".home-widget-row");
    h.render(summary);
    expect(h.button.querySelector(".home-widget-row")).toBe(firstRow);
    h.render(dashboardWidgetSummaries({ sessions: [
      { id: "new", title: "New chat", updatedAt: 4000, unreadCount: 1 },
    ] }).conversations);
    expect(h.root.querySelector('[data-home-widget="conversations"]')).toBe(h.button);
    expect(h.documentRoot.activeElement).toBe(h.button);
    expect(h.button.textContent).toContain("New chat");
    h.button.dispatch("click");
    expect(activated).toHaveBeenCalledOnce();
  });

  test("shows the two most recent conversations while the global badge includes older unread replies", () => {
    const h = createCard();
    h.render(dashboardWidgetSummaries({ sessions }).conversations);
    const rows = h.button.querySelectorAll(".home-widget-row");
    expect(rows.map((row) => row.querySelector(".home-widget-item-title")?.textContent))
      .toEqual(["Latest chat", "Previous chat"]);
    expect(h.button.textContent).not.toContain("Older unread chat");
    expect(rows[0]?.querySelector('[role="img"]')?.attributes.get("aria-label")).toBe("2 unread messages");
    expect(rows[1]?.querySelector('[role="img"]')).toBeNull();
    const badge = h.button.querySelector(".home-widget-badge")!;
    expect(badge.hidden).toBe(false);
    expect(badge.querySelector('[role="img"]')?.attributes.get("aria-label"))
      .toBe("9 unread messages in all conversations");
    h.render(dashboardWidgetSummaries({ sessionOverview: { sessions, unreadCount: 12 } }).conversations);
    expect(badge.textContent).toBe("12");
  });

  test("loading and refresh failures clear stale healthy previews and badges", () => {
    const healthy = { sessions, runs: [{ id: "run", title: "Report", status: "succeeded", scheduledAt: 3000 }],
      approvals: [{ event: { name: "tool.approval.required", tool: "write_file", meta: { path: "report.txt" } } }] };
    const cases = [
      ["conversations", "sessionsError", "Status unavailable"],
      ["conversations", "loadingSessions", "Loading"],
      ["activity", "activityError", "Status unavailable"],
      ["activity", "loadingActivity", "Loading"],
      ["approvals", "approvalsError", "Status unavailable"],
      ["approvals", "loadingApprovals", "Loading"],
    ] as const;
    for (const [id, flag, status] of cases) {
      const h = createCard(id);
      h.render(dashboardWidgetSummaries(healthy)[id]);
      expect(h.button.querySelector(".home-widget-symbol")).not.toBeNull();
      h.render(dashboardWidgetSummaries({ ...healthy, [flag]: true })[id]);
      expect(h.button.querySelector(".home-widget-status")?.textContent).toBe(status);
      expect(h.button.querySelector(".home-widget-symbol")).toBeNull();
      expect(h.button.querySelector(".home-widget-badge")?.hidden).toBe(true);
    }
  });

  test("activity previews distinguish running, completed and failed outcomes with accessible symbols", () => {
    const cases = [["running", "Running", "active"], ["succeeded", "Completed", "success"], ["failed", "Failed", "failed"]];
    for (const [status, label, tone] of cases) {
      const h = createCard("activity");
      const runs = [
        { id: "old", title: "Older job", scheduledAt: 1000, status: "succeeded" },
        { id: "new", title: "Latest job", scheduledAt: 3000, status },
        { id: "second", title: "Previous job", scheduledAt: 2000, status: "pending" },
      ];
      h.render(dashboardWidgetSummaries({ runs }).activity);
      const rows = h.button.querySelectorAll(".home-widget-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.querySelector(".home-widget-item-title")?.textContent).toBe("Latest job");
      expect(rows[0]?.querySelector('[role="img"]')?.attributes.get("aria-label")).toBe(label);
      expect(rows[0]?.querySelector('[role="img"]')?.dataset.tone).toBe(tone);
      expect(rows[1]?.querySelector('[role="img"]')?.attributes.get("aria-label")).toBe("Waiting to run");
    }
  });

  test("approval previews show the tool and target, falling back to the conversation when target is absent", () => {
    const h = createCard("approvals");
    const approvals = [
      { sessionId: "one", event: { name: "tool.approval.required", tool: "write_file", meta: { path: "/reports/draft.txt" } } },
      { sessionId: "two", event: { name: "tool.approval.required", tool: "exec" } },
      { sessionId: "three", event: { name: "tool.approval.required", tool: "web_fetch" } },
    ];
    h.render(dashboardWidgetSummaries({ approvals, sessions: [{ id: "two", displayName: "Budget review" }] }).approvals);
    const rows = h.button.querySelectorAll(".home-widget-row");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelector(".home-widget-item-title")?.textContent)).toEqual(["file writer", "terminal"]);
    expect(rows.map((row) => row.querySelector(".home-widget-meta")?.textContent)).toEqual(["/reports/draft.txt", "Budget review"]);
    expect(rows.every((row) => row.querySelector('[role="img"]')?.attributes.get("aria-label") === "Awaiting approval")).toBe(true);
    expect(h.button.querySelector(".home-widget-badge")?.textContent).toBe("3");
  });

  test("renders metrics, computer checks and the active automation without losing accessible status", () => {
    const h = createCard("computer", "Your computer");
    const indicator = { icon: "success", label: "Connected", tone: "success" };
    h.render({ title: "Spark", preview: { kind: "metrics", items: [{ label: "Memories", indicator: { ...indicator, value: 4 } }] } });
    expect(h.button.querySelector(".home-widget-metric")?.textContent).toBe("4Memories");
    h.render({ title: "Your computer", preview: { kind: "computer", title: "Work laptop", detail: "macOS",
      items: [{ label: "Connection", indicator }] } });
    expect(h.button.querySelector(".home-widget-device")?.textContent).toBe("Work laptopmacOS");
    expect(h.button.attributes.get("aria-description")).toContain("Work laptop");
    expect(h.button.attributes.get("aria-description")).toContain("macOS");
    expect(h.button.querySelector(".home-widget-check")?.querySelector('[role="img"]')?.attributes.get("aria-label")).toBe("Connected");
    h.render(dashboardWidgetSummaries({ activeAutomations: [{ title: "Daily briefing" }, { title: "Backup" }] }).automations);
    expect(h.button.querySelector(".home-widget-automation")?.textContent).toContain("Daily briefing");
    expect(h.button.querySelector('[role="img"]')?.attributes.get("aria-label")).toBe("2 automations in progress");
    expect(h.button.querySelector(".home-widget-device")).toBeNull();
  });
});
