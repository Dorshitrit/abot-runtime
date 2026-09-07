import { describe, expect, test } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import * as presentation from "../../web-ui/app/lib/dashboard-presentation.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderDashboardActivity } from "../../web-ui/app/components/dashboard/activity.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderDashboardConversations } from "../../web-ui/app/components/dashboard/recent-conversations.js";

const {
  projectDashboardConversations,
  projectDashboardActivity,
  dashboardTimePresentation,
} = presentation;

function conversation(id: string, updatedAt: number, unreadCount = 0) {
  return { id, title: id, updatedAt, unreadCount };
}

describe("dashboard recent conversations", () => {
  test("all unread conversations survive the recent cutoff and remain deduplicated", () => {
    const unread = Array.from({ length: 9 }, (_, index) =>
      conversation(`unread-${index}`, index + 1, 2),
    );
    const sessions = [
      conversation("new-read", 100),
      ...unread,
      conversation("unread-1", 1, 2),
    ];
    const before = structuredClone(sessions);
    const result = projectDashboardConversations(sessions);
    expect(result.conversations).toHaveLength(9);
    expect(
      result.conversations.every(
        (row: { unreadCount: number }) => row.unreadCount > 0,
      ),
    ).toBe(true);
    expect(result.totalCount).toBe(10);
    expect(result.unreadCount).toBe(18);
    expect(sessions).toEqual(before);
  });

  test("unread rows lead, remaining slots are recent, and reading never removes the conversation", () => {
    const rows = [
      conversation("new", 300),
      conversation("middle", 200),
      conversation("old-unread", 100, 1),
    ];
    expect(
      projectDashboardConversations(rows, 2).conversations.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual(["old-unread", "new"]);
    const allRead = rows.map((row) => ({ ...row, unreadCount: 0 }));
    const result = projectDashboardConversations(allRead);
    expect(result.conversations.map((row: { id: string }) => row.id)).toEqual([
      "new",
      "middle",
      "old-unread",
    ]);
    expect(result.unreadCount).toBe(0);
    const html = renderDashboardConversations({ sessions: allRead });
    expect(html).toContain('data-session-id="old-unread"');
    expect(html).not.toContain("home-panel-empty");
    expect(html).not.toContain("home-unread-count");
  });

  test("boolean unread state has a visible badge even when a count is not supplied", () => {
    const result = projectDashboardConversations([
      { id: "one", hasUnread: true },
    ]);
    expect(result.unreadCount).toBe(1);
    expect(result.conversations[0].unreadCount).toBe(1);
  });

  test("only a successful empty session list shows the fresh-start state", () => {
    expect(renderDashboardConversations({ sessions: [] })).toContain(
      "home-panel-empty",
    );
    for (const state of [{ loading: true }, { error: "private_reason" }]) {
      const html = renderDashboardConversations({ sessions: [], ...state });
      expect(html).not.toContain("home-panel-empty");
      expect(html).not.toContain("private_reason");
    }
  });

  test("conversation titles and identities are escaped before rendering", () => {
    const html = renderDashboardConversations({
      sessions: [
        {
          id: 'one" onclick="bad()',
          title: "<script>bad()</script>",
          unreadCount: 2,
        },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('data-session-id="one" onclick=');
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("dashboard job activity", () => {
  test("preserves scheduled run chronology when an older run finishes late", () => {
    const runs = [
      {
        id: "older",
        title: "Previous title",
        status: "succeeded",
        scheduledAt: "2026-09-01T08:00:00Z",
        finishedAt: "2026-09-01T10:30:00Z",
        sessionId: "s1",
        requestId: "r1",
      },
      {
        id: "latest",
        title: "Failed job",
        status: "failed",
        scheduledAt: "2026-09-01T08:10:00Z",
        finishedAt: "2026-09-01T08:40:00Z",
        sessionId: "s2",
        requestId: "r2",
      },
    ];
    const before = structuredClone(runs);
    const result = projectDashboardActivity(runs);
    expect(result.map((row: { id: string }) => row.id)).toEqual([
      "latest",
      "older",
    ]);
    expect(result[0]).toMatchObject({
      statusLabel: "Failed",
      tone: "failed",
      sessionId: "s2",
      requestId: "r2",
      timestamp: "2026-09-01T08:10:00Z",
    });
    expect(result[1]).toMatchObject({
      title: "Previous title",
      statusLabel: "Completed",
    });
    expect(runs).toEqual(before);
  });

  test("opens exact recorded requests, but pending runs without requests lead to Jobs", () => {
    const html = renderDashboardActivity({
      runs: [
        {
          id: "done",
          title: "<img src=x>",
          status: "succeeded",
          sessionId: "s1",
          requestId: "r1",
        },
        { id: "pending", title: "Pending", status: "pending", sessionId: "s2" },
      ],
    });
    expect(html).toContain(
      'data-dashboard-action="conversation" data-session-id="s1" data-request-id="r1"',
    );
    expect(html).toContain(
      'data-dashboard-action="jobs" data-session-id="s2" data-request-id=""',
    );
    expect(html).not.toContain("<img");
  });

  test("suggestions appear only for a successful empty activity list", () => {
    const template = {
      id: "briefing",
      title: "Briefing",
      timingLabel: "Daily",
      description: "News",
    };
    expect(renderDashboardActivity({ templates: [template] })).toContain(
      'data-template-id="briefing"',
    );
    for (const state of [
      { loading: true },
      { error: "private_reason" },
      { supported: false },
    ]) {
      const html = renderDashboardActivity({ templates: [template], ...state });
      expect(html).not.toContain("data-template-id");
      expect(html).not.toContain("private_reason");
    }
  });

  test("refresh errors preserve recorded activity and provide a retry", () => {
    const html = renderDashboardActivity({
      runs: [{ id: "run", title: "Recorded result", status: "succeeded" }],
      error: "failed",
    });
    expect(html).toContain("Recorded result");
    expect(html).toContain('data-dashboard-action="refresh"');
    expect(html).not.toContain("home-suggestions");
  });

  test("relative time accepts numeric session timestamps and does not invent invalid dates", () => {
    const now = Date.parse("2026-09-06T12:00:00Z");
    expect(dashboardTimePresentation(String(now - 120000), now).label).toBe(
      "2m ago",
    );
    expect(dashboardTimePresentation("invalid", now)).toBeNull();
    expect(dashboardTimePresentation(null, now)).toBeNull();
  });
});
