import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSessionSidebarController } from "../../web-ui/app/controllers/session-sidebar-controller.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { sidebarStorage, SidebarElement } from "./support/session-sidebar-dom.js";

function fixture() {
  const storage = sidebarStorage();
  const preferences = createClientPreferences(storage);
  const render = vi.fn();
  const showToast = vi.fn();
  const sidebar = createSessionSidebarController({
    state: { sessions: [{ id: "one" }], pinnedSessionIds: [] },
    preferences, selectedEnvironmentId: () => "prod", render, showToast,
  });
  return { storage, preferences, render, showToast, sidebar };
}

describe("explicit local conversation archive", () => {
  test("archives once and reports success on repeated calls without restoring or duplicating the entry", () => {
    const f = fixture();
    expect(f.sidebar.archiveSession("one")).toBe(true);
    expect(f.sidebar.archiveSession("one")).toBe(true);
    expect(f.preferences.loadSessionSidebar("prod").archivedSessionIds).toEqual(["one"]);
    expect(f.storage.setItem).toHaveBeenCalledOnce();
    expect(f.render).toHaveBeenCalledOnce();
    expect(f.showToast).toHaveBeenCalledExactlyOnceWith("Conversation archived in this browser");
    expect(f.sidebar.visibleSessions()).toEqual([]);
  });

  test("reports persistence failure and leaves the session visible; a missing ID has no side effects", () => {
    const f = fixture();
    expect(f.sidebar.archiveSession("")).toBe(false);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    expect(f.sidebar.archiveSession("one")).toBe(false);
    expect(f.render).not.toHaveBeenCalled();
    expect(f.sidebar.visibleSessions()).toEqual([{ id: "one" }]);
    expect(f.showToast).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "failed");
  });

  test("the existing menu toggles restoration through the same persistence owner", () => {
    const f = fixture();
    const row = new SidebarElement("div");
    row.innerHTML = '<button class="session-open-button"></button><button class="archive-action"></button>';
    f.sidebar.bindItem(row, { id: "one" });
    f.sidebar.archiveSession("one");
    row.querySelector(".archive-action")!.dispatch("click");
    expect(f.preferences.loadSessionSidebar("prod").archivedSessionIds).toEqual([]);
    expect(f.showToast).toHaveBeenLastCalledWith("Conversation restored");
    expect(f.sidebar.archiveSession("one")).toBe(true);
    expect(f.preferences.loadSessionSidebar("prod").archivedSessionIds).toEqual(["one"]);
  });
});
