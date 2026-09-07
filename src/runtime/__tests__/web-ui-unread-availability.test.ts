import { afterEach, describe, expect, test, vi } from "vitest";

import { mergeSessionListReadState } from "../../web-ui/app/lib/session-read-state.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderDashboardConversations } from "../../web-ui/app/components/dashboard/recent-conversations.js";

type Session = { id: string } & Record<string, unknown>;

function sessionHarness(session: Session) {
  const rows: Array<{ innerHTML: string }> = [];
  let openConversation = () => {};
  vi.stubGlobal("document", {
    createElement: () => ({
      className: "",
      innerHTML: "",
      querySelector: (selector: string) =>
        selector === ".session-open-button"
          ? {
              addEventListener: (_type: string, listener: () => void) => {
                openConversation = listener;
              },
            }
          : null,
    }),
  });
  const state = {
    sessions: [session],
    pinnedSessionIds: [],
    busySessionIds: new Set(),
    sessionQuery: "",
    currentSessionId: "",
  };
  const onOpen = vi.fn();
  const controller = createSessionController({
    state,
    dom: {
      sessionsList: {
        innerHTML: "",
        appendChild: (row: { innerHTML: string }) => rows.push(row),
      },
      sessionsCount: { textContent: "" },
    },
    sessionActionsMenu: { reset: vi.fn() },
    shell: { setSessionsDrawerOpen: vi.fn() },
    onOpen,
    confirmAction: vi.fn(),
    copyText: vi.fn(),
  });
  return { state, controller, rows, onOpen, open: () => openConversation() };
}

const knownReadState = {
  lastReadAt: 200,
  lastReadMessageId: "8",
  unreadCount: 3,
  hasUnread: true,
};

function unavailableSession(id = "session-one"): Session {
  return {
    id,
    title: "Available conversation",
    readStateStatus: "unavailable",
    lastReadAt: null,
    lastReadMessageId: null,
    unreadCount: null,
    hasUnread: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Web UI unread availability", () => {
  test("an unavailable list preserves known read state and fresh conversation metadata", () => {
    const incoming = unavailableSession();
    const merged = mergeSessionListReadState(
      [incoming],
      [{ id: incoming.id, ...knownReadState, readStateStatus: "available" }],
    );

    expect(merged[0]).toMatchObject({
      title: "Available conversation",
      ...knownReadState,
      readStateStatus: "unavailable",
      readState: { ...knownReadState, readStateStatus: "unavailable" },
    });
    expect(incoming.unreadCount).toBeNull();
    expect(mergeSessionListReadState([incoming], [])[0]).toBe(incoming);
  });

  test("an unavailable snapshot flags the sidebar without erasing counts or blocking opening", () => {
    const harness = sessionHarness({ id: "session-one", ...knownReadState });

    expect(
      harness.controller.applyReadState("session-one", unavailableSession()),
    ).toBe(true);
    expect(harness.state.sessions[0]).toMatchObject({
      ...knownReadState,
      readStateStatus: "unavailable",
      readState: { ...knownReadState, readStateStatus: "unavailable" },
    });
    expect(harness.rows.at(-1)?.innerHTML).toContain(
      "Unread status unavailable",
    );
    expect(harness.rows.at(-1)?.innerHTML).not.toContain('title="3 unread"');
    harness.open();
    expect(harness.onOpen).toHaveBeenCalledExactlyOnceWith("session-one");
  });

  test("a delayed healthy acknowledgment cannot clear an outage; a healthy list can", () => {
    const harness = sessionHarness({
      ...unavailableSession(),
      ...knownReadState,
    });
    harness.controller.applyReadState("session-one", {
      readStateStatus: "available",
      lastReadAt: 300,
      lastReadMessageId: "11",
      unreadCount: 0,
      hasUnread: false,
    });
    expect(harness.state.sessions[0]).toMatchObject({
      lastReadAt: 300,
      unreadCount: 0,
      readStateStatus: "unavailable",
    });
    const outage = renderDashboardConversations({
      sessions: harness.state.sessions,
    });
    expect(outage).toContain("Unread status unavailable");
    expect(outage).not.toContain("All clear");

    harness.state.sessions = mergeSessionListReadState(
      [
        {
          id: "session-one",
          readStateStatus: "available",
          lastReadAt: 300,
          lastReadMessageId: "11",
          unreadCount: 1,
          hasUnread: true,
        },
      ],
      harness.state.sessions,
    );
    const recovered = renderDashboardConversations({
      sessions: harness.state.sessions,
    });
    expect(recovered).not.toContain("Unread status unavailable");
    expect(recovered).toContain('aria-label="1 unread messages"');
  });

  test("healthy list recovery keeps a newer cursor while clearing unavailable flags", () => {
    const merged = mergeSessionListReadState(
      [
        {
          id: "session-one",
          readStateStatus: "available",
          lastReadAt: 100,
          lastReadMessageId: "4",
          unreadCount: 5,
          hasUnread: true,
        },
      ],
      [{ ...unavailableSession(), ...knownReadState }],
    );

    expect(merged[0]).toMatchObject({
      ...knownReadState,
      readStateStatus: "available",
      readState: { ...knownReadState, readStateStatus: "available" },
    });
  });

  test("unavailable rows stay actionable and never display their stale numeric badge", () => {
    const html = renderDashboardConversations({
      sessions: [{ ...unavailableSession(), ...knownReadState }],
    });
    expect(html).toContain('data-dashboard-action="conversation"');
    expect(html).toContain('data-session-id="session-one"');
    expect(html).toContain("Unread status unavailable");
    expect(html).not.toContain("All clear");
    expect(html).not.toContain("home-small-count");
    expect(html).not.toContain("home-unread-count");
  });

  test("an unavailable row beyond the recent cutoff still prevents an all-clear summary", () => {
    const sessions = Array.from({ length: 7 }, (_, index) => ({
      id: `known-${index}`,
      updatedAt: index + 1,
      unreadCount: 0,
    }));
    const html = renderDashboardConversations({
      sessions: [...sessions, { ...unavailableSession(), updatedAt: 0 }],
    });
    expect(html).toContain("Unread status unavailable");
    expect(html).not.toContain("All clear");
    expect(html).toContain('data-dashboard-action="conversations"');
  });

  test("a previously unread conversation retains its priority during an outage", () => {
    const recent = Array.from({ length: 7 }, (_, index) => ({
      id: `known-${index}`,
      updatedAt: index + 1,
      unreadCount: 0,
    }));
    const html = renderDashboardConversations({
      sessions: [
        ...recent,
        { ...unavailableSession(), ...knownReadState, updatedAt: 0 },
      ],
    });
    expect(html).toContain('data-session-id="session-one"');
    expect(html.indexOf('data-session-id="session-one"')).toBeLessThan(
      html.indexOf('data-session-id="known-6"'),
    );
    expect(html).toContain("Unread status unavailable");
    expect(html).not.toContain("home-small-count");
    expect(html).not.toContain("home-unread-count");
  });

  test("mixed availability shows known row counts without claiming a complete total", () => {
    const html = renderDashboardConversations({
      sessions: [unavailableSession(), { id: "known", unreadCount: 2 }],
    });
    expect(html).toContain(
      'class="home-small-count" aria-label="2 unread messages"',
    );
    expect(html).not.toContain("home-unread-count");
    expect(html).toContain("Unread status unavailable");
  });

  test("legacy rows without availability status retain their existing read behavior", () => {
    const legacy = { id: "legacy", unreadCount: 0, hasUnread: false };
    expect(mergeSessionListReadState([legacy], [])[0]).toBe(legacy);
    const html = renderDashboardConversations({ sessions: [legacy] });
    expect(html).toContain("All clear. No unread messages.");
    expect(html).not.toContain("Unread status unavailable");
  });
});
