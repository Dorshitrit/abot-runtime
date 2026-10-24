import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderProjectSessionGroups } from "../../web-ui/app/components/project-session-groups.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { allSidebarElements, dragEvent, SidebarElement, sidebarStorage } from "./support/session-sidebar-dom.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Session = { id: string; title?: string; projectId?: string };

function isVisibleSidebarElement(element: ContextElement): boolean {
  for (let node: ContextElement | null = element; node; node = node.parentElement) {
    if (node.hidden) return false;
  }
  return true;
}

function fixture(sessions: Session[], pinnedSessionIds: string[] = [], saved = sidebarStorage(), deletedProjectIds: string[] = []) {
  let environment = "prod";
  const root = new SidebarElement("div");
  const documentRoot = {
    createElement: (tag: string) => new SidebarElement(tag),
    getElementById: (id: string) => allSidebarElements(root).find((element) => element.id === id),
  };
  vi.stubGlobal("document", documentRoot);
  const state = { sessions, pinnedSessionIds, sessionModels: {}, busySessionIds: new Set(), currentSessionId: "", sessionQuery: "" };
  const preferences = createClientPreferences(saved);
  const onOpen = vi.fn();
  const showToast = vi.fn();
  const client = { deleteSession: vi.fn(), clearSessionMessages: vi.fn() };
  const controller = createSessionController({
    state, preferences, client, onOpen, selectedEnvironmentId: () => environment,
    getDeletedProjectIds: () => deletedProjectIds,
    dom: { sessionsList: root, sessionsCount: new SidebarElement("span") },
    sessionActionsMenu: { reset: vi.fn() }, shell: { showToast, setSessionsDrawerOpen: vi.fn() },
    confirmAction: () => true, copyText: vi.fn(), onClearSessionMode: vi.fn(), onSaveModelPreferences: vi.fn(),
    onClearCurrent: vi.fn(), onReload: vi.fn(), onControlEvent: vi.fn(),
    renderGroups: (input: object) => {
      renderProjectSessionGroups({
        ...input, projects: [{ id: "project", name: "Project", directory: "/project" }],
        query: state.sessionQuery, documentRoot, onNewConversation: vi.fn(), onRetry: vi.fn(), deletedProjectIds,
      });
      return true;
    },
  });
  const row = (id: string) => allSidebarElements(root).find((element) => element.querySelector(".session-open-button")?.id === `session-open-${id}` && element.classList.contains("session-item"))!;
  const ids = () => allSidebarElements(root).filter(isVisibleSidebarElement).filter((element) => element.classList.contains("session-open-button")).map((element) => element.id.replace("session-open-", ""));
  controller.render();
  return { controller, root, state, preferences, saved, client, onOpen, showToast, row, ids,
    setEnvironment: (id: string) => { environment = id; controller.render(); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("conversation sidebar", () => {
  test("renders global pins before every project and standalone group without duplicates or menu-ID collisions", () => {
    const f = fixture([
      { id: "ordinary" }, { id: "project-child", projectId: "project" },
      { id: "pin-project", projectId: "project" }, { id: "pin-ordinary" },
    ], ["pin-ordinary", "pin-project"]);
    expect(f.ids()).toEqual(["pin-ordinary", "pin-project", "project-child", "ordinary"]);
    const pinnedHeading = f.root.children.findIndex((element) => element.classList.contains("pinned-conversations-heading"));
    const projectGroup = f.root.children.findIndex((element) => element.classList.contains("project-session-group"));
    expect(pinnedHeading).toBeLessThan(projectGroup);
    const menus = f.ids().map((id) => (f.row(id) as SidebarElement).innerHTML.match(/aria-controls="([^"]+)"/)?.[1]);
    expect(new Set(menus).size).toBe(4);
    expect(f.row("pin-project").parentElement).toBe(f.root);
  });

  test("Archive hides a pinned or open conversation, survives reload, and restores it without deleting the session or its messages", async () => {
    const f = fixture([{ id: "one" }, { id: "two" }], ["one"]);
    f.state.currentSessionId = "one";
    f.row("one").querySelector(".archive-action")!.dispatch("click");
    await settle();
    expect(f.ids()).toEqual(["two"]);
    expect(f.state.currentSessionId).toBe("one");
    expect(f.state.sessions).toHaveLength(2);
    expect((f.root.querySelector(".session-archive-toggle") as SidebarElement).focus).toHaveBeenCalledOnce();
    expect(f.client.deleteSession).not.toHaveBeenCalled();
    expect(f.client.clearSessionMessages).not.toHaveBeenCalled();
    const reopened = fixture(f.state.sessions, ["one"], f.saved);
    expect(reopened.ids()).toEqual(["two"]);
    reopened.root.querySelector(".session-archive-toggle")!.dispatch("click");
    expect(reopened.ids()).toEqual(["one"]);
    expect(reopened.row("one").querySelector(".pin-action")!.disabled).toBe(true);
    reopened.row("one").querySelector(".session-open-button")!.dispatch("click");
    expect(reopened.onOpen).toHaveBeenCalledExactlyOnceWith("one");
    reopened.row("one").querySelector(".archive-action")!.dispatch("click");
    await settle();
    reopened.root.querySelector(".session-archive-toggle")!.dispatch("click");
    expect(reopened.ids()).toEqual(["one", "two"]);
  });

  test("archives and manual order stay in their selected environment", async () => {
    const f = fixture([{ id: "one" }, { id: "two" }]);
    f.row("one").querySelector(".archive-action")!.dispatch("click");
    await settle();
    f.root.querySelector(".session-archive-toggle")!.dispatch("click");
    f.setEnvironment("dev");
    expect(f.ids()).toEqual(["one", "two"]);
    f.setEnvironment("prod");
    expect(f.ids()).toEqual(["two"]);
  });

  test("dragging reorders within groups, retains search-hidden rows, and rejects cross-project moves", async () => {
    const f = fixture([{ id: "one", title: "match" }, { id: "hidden" }, { id: "two", title: "match" }, { id: "child", projectId: "project" }]);
    f.state.sessionQuery = "match";
    f.controller.render();
    f.row("two").querySelector(".session-open-button")!.dispatch("dragstart", dragEvent());
    const over = dragEvent();
    f.row("one").dispatch("dragover", over);
    expect(over.preventDefault).toHaveBeenCalledOnce();
    f.row("one").dispatch("drop", dragEvent());
    await settle();
    f.state.sessionQuery = "";
    f.controller.render();
    expect(f.ids()).toEqual(["child", "two", "one", "hidden"]);
    const reopened = fixture(f.state.sessions, [], f.saved);
    expect(reopened.ids()).toEqual(f.ids());
    reopened.row("two").querySelector(".session-open-button")!.dispatch("dragstart", dragEvent());
    const blocked = dragEvent();
    reopened.row("child").dispatch("dragover", blocked);
    expect(blocked.preventDefault).not.toHaveBeenCalled();
    reopened.row("child").dispatch("drop", dragEvent());
    await settle();
    expect(reopened.ids()).toEqual(["child", "two", "one", "hidden"]);
  });

  test("keyboard menu moves persist pin order across project ownership and focus the moved conversation", async () => {
    const f = fixture([{ id: "one", projectId: "project" }, { id: "two" }], ["one", "two"]);
    f.row("two").querySelector(".move-up-action")!.dispatch("click");
    await settle();
    expect(f.ids()).toEqual(["two", "one"]);
    expect(f.preferences.loadPinnedSessions()).toEqual(["two", "one"]);
    expect((f.row("two").querySelector(".session-open-button") as SidebarElement).focus).toHaveBeenCalledOnce();
  });

  test.each(["menu", "drag"])("%s moves preserve the order of unloaded and archived sessions", async (method) => {
    const f = fixture([{ id: "one" }, { id: "two" }]);
    f.preferences.saveSessionSidebar("prod", {
      orderedSessionIds: ["before", "one", "between", "two", "archived", "after"],
      archivedSessionIds: ["archived"],
    });
    f.controller.render();
    if (method === "menu") f.row("two").querySelector(".move-up-action")!.dispatch("click");
    else {
      f.row("two").querySelector(".session-open-button")!.dispatch("dragstart", dragEvent());
      f.row("one").dispatch("drop", dragEvent());
    }
    await settle();
    expect(f.preferences.loadSessionSidebar("prod")).toEqual({
      orderedSessionIds: ["before", "two", "one", "between", "archived", "after"],
      archivedSessionIds: ["archived"],
    });
    const reloaded = fixture(["before", "one", "between", "two", "archived", "after"].map((id) => ({ id })), [], f.saved);
    expect(reloaded.ids()).toEqual(["before", "two", "one", "between", "after"]);
  });

  test("moving a new unranked session into a partial saved order preserves unloaded IDs", async () => {
    const f = fixture([{ id: "new" }, { id: "one" }]);
    f.preferences.saveSessionSidebar("prod", { orderedSessionIds: ["one", "unloaded"], archivedSessionIds: [] });
    f.controller.render();
    f.row("new").querySelector(".move-down-action")!.dispatch("click");
    await settle();
    expect(f.preferences.loadSessionSidebar("prod").orderedSessionIds).toEqual(["one", "new", "unloaded"]);
  });

  test.each(["ordinary", "project", "pinned"])("keyboard moves skip search-hidden siblings in the %s group", async (group) => {
    const sessions = ["hidden-before", "one", "hidden-between", "two", "hidden-after"].map((id) => ({
      id, title: ["one", "two"].includes(id) ? "match" : "hidden",
      ...(group === "project" ? { projectId: "project" } : {}),
    }));
    const pins = group === "pinned" ? sessions.map((session) => session.id) : [];
    const f = fixture(sessions, pins);
    f.state.sessionQuery = "match";
    f.controller.render();
    f.row("one").querySelector(".move-up-action")!.dispatch("click");
    await settle();
    f.row("two").querySelector(".move-down-action")!.dispatch("click");
    await settle();
    expect(f.saved.setItem).not.toHaveBeenCalled();
    f.row("one").querySelector(".move-down-action")!.dispatch("click");
    await settle();
    expect(f.ids()).toEqual(["two", "one"]);
    f.row("one").querySelector(".move-up-action")!.dispatch("click");
    await settle();
    expect(f.ids()).toEqual(["one", "two"]);
    f.state.sessionQuery = "";
    f.controller.render();
    expect(f.ids()).toEqual(["hidden-before", "hidden-between", "one", "two", "hidden-after"]);
    const reloadedPins = group === "pinned" ? f.preferences.loadPinnedSessions() : [];
    expect(fixture(sessions, reloadedPins, f.saved).ids()).toEqual(f.ids());
  });

  test("the project renderer preserves manually ordered children after rerender and preference reload", async () => {
    const sessions = [
      { id: "first", projectId: "project" }, { id: "ordinary" },
      { id: "second", projectId: "project" },
    ];
    const f = fixture(sessions);
    f.row("second").querySelector(".move-up-action")!.dispatch("click");
    await settle();
    expect(f.ids()).toEqual(["second", "first", "ordinary"]);
    expect(f.row("second").parentElement).toBe(f.row("first").parentElement);
    f.controller.render();
    expect(f.ids()).toEqual(["second", "first", "ordinary"]);
    expect(fixture(sessions, [], f.saved).ids()).toEqual(["second", "first", "ordinary"]);
  });

  test("storage failure keeps the conversation visible and reports the failed local action", async () => {
    const f = fixture([{ id: "one" }]);
    f.saved.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    f.row("one").querySelector(".archive-action")!.dispatch("click");
    await settle();
    expect(f.ids()).toEqual(["one"]);
    expect(f.showToast).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "failed");
  });

  test("project preview caps neither global pinned sessions nor standalone conversations", () => {
    const pinned = Array.from({ length: 7 }, (_, index) => ({ id: `pin-${index}`, projectId: "project" }));
    const project = Array.from({ length: 7 }, (_, index) => ({ id: `project-${index}`, projectId: "project" }));
    const ordinary = Array.from({ length: 8 }, (_, index) => ({ id: `ordinary-${index}` }));
    const f = fixture([...pinned, ...project, ...ordinary], pinned.map((session) => session.id));
    expect(f.ids()).toEqual([...pinned, ...project.slice(0, 5), ...ordinary].map((session) => session.id));
  });

  test("project keyboard moves stop at the preview boundary while drag preserves hidden siblings", async () => {
    const sessions = Array.from({ length: 7 }, (_, index) => ({ id: `row-${index}`, projectId: "project" }));
    const f = fixture(sessions);
    f.row("row-4").querySelector(".move-down-action")!.dispatch("click");
    await settle();
    expect(f.saved.setItem).not.toHaveBeenCalled();
    expect(f.ids()).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4"]);
    f.row("row-4").querySelector(".session-open-button")!.dispatch("dragstart", dragEvent());
    f.row("row-0").dispatch("drop", dragEvent());
    await settle();
    expect(f.ids()).toEqual(["row-4", "row-0", "row-1", "row-2", "row-3"]);
    expect(f.preferences.loadSessionSidebar("prod").orderedSessionIds).toEqual(["row-4", "row-0", "row-1", "row-2", "row-3", "row-5", "row-6"]);
    f.root.querySelector(".project-session-more")!.dispatch("click");
    f.row("row-5").querySelector(".move-down-action")!.dispatch("click");
    await settle();
    expect(f.preferences.loadSessionSidebar("prod").orderedSessionIds.slice(-2)).toEqual(["row-6", "row-5"]);
  });
});

test.each([false, true])("a rejected pin change preserves acknowledged state across rerender and later changes, initially pinned=%s", async (pinned) => {
  const previous = pinned ? ["one", "two"] : ["two"];
  const f = fixture([{ id: "one" }, { id: "two" }], previous);
  let reject!: (error: Error) => void;
  const save = vi.spyOn(f.preferences, "savePinnedSessions").mockImplementationOnce(() =>
    new Promise<void>((_resolve, fail) => { reject = fail; }) as never);
  const changing = f.controller.togglePinned("one");
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(f.state.pinnedSessionIds).toBe(previous);
  f.controller.render();
  expect(f.row("one").classList.contains("pinned")).toBe(pinned);
  reject(new Error("preference conflict")); await changing;
  expect(f.state.pinnedSessionIds).toBe(previous);
  f.controller.render();
  expect(f.row("one").classList.contains("pinned")).toBe(pinned);
  expect(f.showToast).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "failed");
  await f.controller.togglePinned("two");
  expect(f.state.pinnedSessionIds).toEqual(pinned ? ["one"] : []);
});

test("rapid pin actions derive from acknowledged predecessors and remain invisible while saving", async () => {
  const f = fixture([{ id: "one" }, { id: "two" }]);
  let accept!: () => void;
  const save = vi.spyOn(f.preferences, "savePinnedSessions").mockImplementationOnce(() =>
    new Promise<void>((resolve) => { accept = resolve; }) as never);
  const first = f.controller.togglePinned("one");
  const second = f.controller.togglePinned("two");
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(f.state.pinnedSessionIds).toEqual([]);
  accept(); await Promise.all([first, second]);
  expect(save.mock.calls).toEqual([[["one"]], [["two", "one"]]]);
  expect(f.state.pinnedSessionIds).toEqual(["two", "one"]);
  expect(f.ids()).toEqual(["two", "one"]);
});

test("pin reordering waits for a pending pin change before deriving its list", async () => {
  const f = fixture([{ id: "one" }, { id: "two" }, { id: "three" }], ["one", "two"]);
  let accept!: () => void;
  const save = vi.spyOn(f.preferences, "savePinnedSessions").mockImplementationOnce(() =>
    new Promise<void>((resolve) => { accept = resolve; }) as never);
  const pinning = f.controller.togglePinned("three");
  f.row("two").querySelector(".move-up-action")!.dispatch("click");
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  accept(); await pinning;
  await vi.waitFor(() => expect(f.state.pinnedSessionIds).toEqual(["three", "two", "one"]));
  expect(save.mock.calls).toEqual([[["three", "one", "two"]], [["three", "two", "one"]]]);
});

test("pin cleanup after deletion shares pending pin updates without restoring deleted pins", async () => {
  const f = fixture([{ id: "one" }, { id: "two" }], ["one"]);
  let accept!: () => void;
  const save = vi.spyOn(f.preferences, "savePinnedSessions").mockImplementationOnce(() =>
    new Promise<void>((resolve) => { accept = resolve; }) as never);
  const pinning = f.controller.togglePinned("two");
  await f.controller.deleteSession("one");
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  accept(); await pinning;
  await vi.waitFor(() => expect(f.state.pinnedSessionIds).toEqual(["two"]));
  expect(f.ids()).toEqual(["two"]);
  expect(f.client.deleteSession).toHaveBeenCalledExactlyOnceWith("one", "prod");
});

test("failed pin cleanup reports separately while a successfully deleted session stays deleted", async () => {
  const f = fixture([{ id: "one" }, { id: "two" }], ["one"]);
  vi.spyOn(f.preferences, "savePinnedSessions").mockRejectedValueOnce(new Error("conflict"));
  await f.controller.deleteSession("one");
  await vi.waitFor(() => expect(f.showToast).toHaveBeenCalledWith(expect.stringContaining("saved pin"), "failed"));
  expect(f.state.pinnedSessionIds).toEqual(["one"]);
  expect(f.ids()).toEqual(["two"]);
});


test("deleted project conversations use general-list move controls without rewriting session ownership", async () => {
  const deletedProjectIds: string[] = [];
  const f = fixture([{ id: "child", projectId: "project" }, { id: "ordinary" }], [], sidebarStorage(), deletedProjectIds);
  expect(f.root.querySelector(".project-session-group")).not.toBeNull();
  deletedProjectIds.push("project");
  f.controller.render();
  expect(f.root.querySelector(".project-session-group")).toBeNull();
  expect(f.ids()).toEqual(["child", "ordinary"]);
  f.row("child").querySelector(".move-down-action")!.dispatch("click");
  await settle();
  expect(f.ids()).toEqual(["ordinary", "child"]);
  expect(f.state.sessions[0]?.projectId).toBe("project");
});
