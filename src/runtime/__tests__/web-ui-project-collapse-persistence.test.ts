import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createProjectsFeature } from "../../web-ui/app/projects-feature.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { SidebarElement, sidebarStorage } from "./support/session-sidebar-dom.js";
import { deferredProjectResult, project, projectClient } from "./support/projects-controller-fixture.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(preferences = createClientPreferences(sidebarStorage())) {
  let environmentId = "prod";
  const element = () => new SidebarElement("div");
  const dom = {
    chatPanel: element(), messagesList: element(), composerForm: element(),
    projectCreationRoot: element(), newProjectButton: element(),
    newSessionButton: element(), sessionsList: element(), environmentSelect: element(),
    refreshSessionsButton: element(), currentProjectContext: element(),
    sessionsPanel: element(), sessionsToggleButton: element(),
  };
  const sessions = [
    { id: "first-child", project: project("first") },
    { id: "second-child", project: project("second") },
  ];
  const state = { sessions, currentSessionId: "", sessionViewVersion: 0, sessionQuery: "" };
  const shell = { showToast: vi.fn() };
  vi.stubGlobal("document", { createElement: (tag: string) => new SidebarElement(tag) });
  const renderSessions = vi.fn(() => {
    dom.sessionsList.replaceChildren();
    feature.renderSessionGroups({
      root: dom.sessionsList, sessions, createSessionItem: () => element(),
    });
  });
  const feature = createProjectsFeature({
    dom, state, preferences, shell, client: projectClient(),
    selectedEnvironmentId: () => environmentId,
    conversationSession: { openSession: vi.fn(), loadSessions: vi.fn() },
    prepareConversation: vi.fn(), renderSessions,
  });
  const group = (id: string) => dom.sessionsList.children.find(
    (child) => child.querySelector(".project-group-content")?.id === "project-sessions-" + id,
  )!;
  renderSessions();
  return {
    preferences, state, shell, renderSessions,
    toggle: (id: string) => group(id).querySelector(".project-group-toggle")!.dispatch("click"),
    isCollapsed: (id: string) => group(id).querySelector(".project-group-content")!.hidden,
    setEnvironment(value: string) { environmentId = value; renderSessions(); },
  };
}

test("collapsed projects survive feature and preference recreation while expanding is saved", () => {
  const storage = sidebarStorage();
  const first = fixture(createClientPreferences(storage));
  first.toggle("first");
  const reopened = fixture(createClientPreferences(storage));
  expect(reopened.isCollapsed("first")).toBe(true);
  expect(reopened.isCollapsed("second")).toBe(false);
  reopened.toggle("first");
  const expanded = fixture(createClientPreferences(storage));
  expect(expanded.isCollapsed("first")).toBe(false);
  expect(expanded.preferences.loadCollapsedProjectIds("prod")).toEqual([]);
});

test("leaving and returning to environments restores each independent project choice", () => {
  const f = fixture();
  f.toggle("first");
  f.setEnvironment("dev");
  expect(f.isCollapsed("first")).toBe(false);
  f.toggle("second");
  f.setEnvironment("prod");
  expect(f.isCollapsed("first")).toBe(true);
  expect(f.isCollapsed("second")).toBe(false);
  f.setEnvironment("dev");
  expect(f.isCollapsed("first")).toBe(false);
  expect(f.isCollapsed("second")).toBe(true);
});

test("search expansion and search toggles do not overwrite saved collapse choices", () => {
  const f = fixture();
  f.toggle("first");
  const save = vi.spyOn(f.preferences, "saveCollapsedProjectIds");
  f.state.sessionQuery = "matching conversation";
  f.renderSessions();
  expect(f.isCollapsed("first")).toBe(false);
  expect(f.isCollapsed("second")).toBe(false);
  f.toggle("first");
  f.toggle("second");
  expect(f.isCollapsed("first")).toBe(true);
  expect(f.isCollapsed("second")).toBe(true);
  expect(save).not.toHaveBeenCalled();
  f.renderSessions();
  expect(f.isCollapsed("first")).toBe(false);
  f.state.sessionQuery = "   ";
  f.renderSessions();
  expect(f.isCollapsed("first")).toBe(true);
  expect(f.isCollapsed("second")).toBe(false);
  expect(f.preferences.loadCollapsedProjectIds("prod")).toEqual(["first"]);
});

test("save rejection renders current preferences without restoring a stale captured set", async () => {
  const f = fixture();
  const pending = deferredProjectResult<void>();
  const save = f.preferences.saveCollapsedProjectIds.bind(f.preferences);
  vi.spyOn(f.preferences, "saveCollapsedProjectIds").mockImplementationOnce(() => pending.promise);
  f.toggle("first");
  expect(f.isCollapsed("first")).toBe(true);
  save("prod", ["second"]);
  f.renderSessions.mockClear();
  pending.reject(new Error("preference write failed"));
  await Promise.resolve();
  expect(f.renderSessions).toHaveBeenCalledOnce();
  expect(f.isCollapsed("first")).toBe(false);
  expect(f.isCollapsed("second")).toBe(true);
  expect(f.preferences.loadCollapsedProjectIds("prod")).toEqual(["second"]);
  expect(f.shell.showToast).toHaveBeenCalledExactlyOnceWith(
    "Could not save project visibility in ABot", "failed",
  );
});

test("rapid toggles compose with pending writes and save the latest expanded choice", async () => {
  const f = fixture();
  const pending = deferredProjectResult<void>();
  const originalSave = f.preferences.saveCollapsedProjectIds.bind(f.preferences);
  const save = vi.spyOn(f.preferences, "saveCollapsedProjectIds").mockImplementation((environment, ids) => {
    originalSave(environment, ids);
    return pending.promise;
  });
  f.toggle("first");
  f.toggle("second");
  f.toggle("first");
  expect(save.mock.calls).toEqual([
    ["prod", ["first"]],
    ["prod", ["first", "second"]],
    ["prod", ["second"]],
  ]);
  pending.resolve();
  await Promise.resolve();
  f.renderSessions();
  expect(f.isCollapsed("first")).toBe(false);
  expect(f.isCollapsed("second")).toBe(true);
  expect(f.shell.showToast).not.toHaveBeenCalled();
});
