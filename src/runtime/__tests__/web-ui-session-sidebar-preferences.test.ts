import { describe, expect, test } from "vitest";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { canReorderSidebarSessions, moveSidebarSession, orderSidebarSessions } from "../../web-ui/app/lib/session-sidebar-order.js";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe("conversation sidebar preferences", () => {
  test("persists archive and manual order independently per environment and preserves existing pins", () => {
    const saved = storage();
    const preferences = createClientPreferences(saved);
    preferences.savePinnedSessions(["pin"]);
    preferences.saveSessionSidebar("prod", { archivedSessionIds: ["one"], orderedSessionIds: ["two", "one"] });
    preferences.saveSessionSidebar("dev", { archivedSessionIds: ["three"], orderedSessionIds: [] });
    const restored = createClientPreferences(saved);
    expect(restored.loadSessionSidebar("prod")).toEqual({ archivedSessionIds: ["one"], orderedSessionIds: ["two", "one"] });
    expect(restored.loadSessionSidebar("dev").archivedSessionIds).toEqual(["three"]);
    expect(restored.loadSessionSidebar("other")).toEqual({ archivedSessionIds: [], orderedSessionIds: [] });
    expect(restored.loadPinnedSessions()).toEqual(["pin"]);
  });

  test.each(["not-json", "null", "[]", '"old"'])("ignores malformed browser preferences: %s", (value) => {
    const saved = storage();
    saved.setItem("abot-web.sessionSidebarByEnvironment", value);
    expect(createClientPreferences(saved).loadSessionSidebar("prod")).toEqual({ archivedSessionIds: [], orderedSessionIds: [] });
  });

  test("drops invalid and duplicate session IDs without modifying another environment", () => {
    const saved = storage();
    saved.setItem("abot-web.sessionSidebarByEnvironment", JSON.stringify({
      prod: { archivedSessionIds: ["one", null, 7, "", "one"], orderedSessionIds: {} },
    }));
    const preferences = createClientPreferences(saved);
    expect(preferences.loadSessionSidebar("prod")).toEqual({ archivedSessionIds: ["one"], orderedSessionIds: [] });
    preferences.saveSessionSidebar("__proto__", { archivedSessionIds: ["safe"], orderedSessionIds: [] });
    expect(preferences.loadSessionSidebar("__proto__").archivedSessionIds).toEqual(["safe"]);
  });
});

describe("conversation sidebar ordering", () => {
  test("retains ordered pins, manual order, and fresh session recency without mutating server sessions", () => {
    const sessions = ["fresh-one", "b", "fresh-two", "a", "pin-two", "pin-one"].map((id) => ({ id }));
    expect(orderSidebarSessions(sessions, ["pin-one", "pin-two"], ["a", "b"]).map((session: { id: string }) => session.id))
      .toEqual(["pin-one", "pin-two", "fresh-one", "fresh-two", "a", "b"]);
    expect(sessions.map((session) => session.id)).toEqual(["fresh-one", "b", "fresh-two", "a", "pin-two", "pin-one"]);
  });

  test("moves before and after targets while preserving sessions hidden by a search", () => {
    expect(moveSidebarSession(["a", "hidden", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "hidden", "b"]);
    expect(moveSidebarSession(["a", "hidden", "b", "c"], "a", "b", "after")).toEqual(["hidden", "b", "a", "c"]);
    expect(moveSidebarSession(["a", "b"], "external", "a", "before")).toEqual(["a", "b"]);
  });

  test("permits reordering only inside the same visible ownership group", () => {
    const project = { id: "one", projectId: "project-one" };
    const sibling = { id: "two", project: { id: "project-one" } };
    const other = { id: "three", projectId: "project-two" };
    expect(canReorderSidebarSessions(project, sibling, [])).toBe(true);
    expect(canReorderSidebarSessions(project, other, [])).toBe(false);
    expect(canReorderSidebarSessions(project, { id: "ordinary" }, [])).toBe(false);
    expect(canReorderSidebarSessions(project, other, ["one", "three"])).toBe(true);
    expect(canReorderSidebarSessions(project, sibling, ["one"])).toBe(false);
    expect(canReorderSidebarSessions(undefined, sibling, [])).toBe(false);
  });
});
