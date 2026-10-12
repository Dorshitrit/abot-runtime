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

describe("explicit conversation archive", () => {
  test("archives once and reports success on repeated calls without restoring or duplicating the entry", async () => {
    const f = fixture();
    expect(await f.sidebar.archiveSession("one")).toBe(true);
    expect(await f.sidebar.archiveSession("one")).toBe(true);
    expect(f.preferences.loadSessionSidebar("prod").archivedSessionIds).toEqual(["one"]);
    expect(f.storage.setItem).toHaveBeenCalledOnce();
    expect(f.render).toHaveBeenCalledOnce();
    expect(f.showToast).toHaveBeenCalledExactlyOnceWith("Conversation archived");
    expect(f.sidebar.visibleSessions()).toEqual([]);
  });

  test("reports persistence failure and leaves the session visible; a missing ID has no side effects", async () => {
    const f = fixture();
    expect(await f.sidebar.archiveSession("")).toBe(false);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    f.storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    expect(await f.sidebar.archiveSession("one")).toBe(false);
    expect(f.render).not.toHaveBeenCalled();
    expect(f.sidebar.visibleSessions()).toEqual([{ id: "one" }]);
    expect(f.showToast).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "failed");
  });

  test("the existing menu toggles restoration through the same persistence owner", async () => {
    const f = fixture();
    const row = new SidebarElement("div");
    row.innerHTML = '<button class="session-open-button"></button><button class="archive-action"></button>';
    f.sidebar.bindItem(row, { id: "one" });
    await f.sidebar.archiveSession("one");
    row.querySelector(".archive-action")!.dispatch("click");
    expect(f.preferences.loadSessionSidebar("prod").archivedSessionIds).toEqual([]);
    await vi.waitFor(() => expect(f.showToast).toHaveBeenLastCalledWith("Conversation restored"));
    expect(await f.sidebar.archiveSession("one")).toBe(true);
    expect(f.preferences.loadSessionSidebar("prod").archivedSessionIds).toEqual(["one"]);
  });
});


test.each([true, false])("archive success is published only after acknowledgement, accepted=%s", async (accepted) => {
  const f = fixture();
  let accept!: () => void;
  let reject!: (error: Error) => void;
  vi.spyOn(f.preferences, "saveSessionSidebar").mockImplementationOnce(() =>
    new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; }));
  const archiving = f.sidebar.archiveSession("one");
  expect(f.render).not.toHaveBeenCalled();
  expect(f.showToast).not.toHaveBeenCalled();
  expect(f.sidebar.visibleSessions()).toEqual([{ id: "one" }]);
  if (accepted) accept();
  else reject(new Error("preference conflict"));
  expect(await archiving).toBe(accepted);
  expect(f.render).toHaveBeenCalledTimes(accepted ? 1 : 0);
  if (accepted) expect(f.showToast).toHaveBeenCalledWith("Conversation archived");
  else expect(f.showToast).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "failed");
});
