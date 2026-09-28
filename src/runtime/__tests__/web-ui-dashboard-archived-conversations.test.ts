import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardFeature } from "../../web-ui/app/dashboard-feature.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { filterSessionsByArchiveState } from "../../web-ui/app/lib/session-archive-visibility.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { allSidebarElements, SidebarElement, sidebarStorage } from "./support/session-sidebar-dom.js";

const dashboard = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../../web-ui/app/components/dashboard/workspace.js", () => ({
  createDashboardWorkspace: () => ({ render: dashboard.render, composerHost: {} }),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("archived conversation visibility", () => {
  test("Archive and Restore publish Home immediately through the shared render callback", () => {
    const root = new SidebarElement("div");
    vi.stubGlobal("document", {
      addEventListener: vi.fn(), createElement: (tag: string) => new SidebarElement(tag),
    });
    const preferences = createClientPreferences(sidebarStorage());
    const state = {
      sessions: [{ id: "one" }, { id: "two" }], pinnedSessionIds: [],
      busySessionIds: new Set(), currentSessionId: "", sessionQuery: "",
    };
    const feature = createDashboardFeature({
      state, preferences, dom: { homeDashboardRoot: {} },
      client: { supportsSchedules: () => false, supportsToolApprovals: () => false },
      shell: {}, schedules: {}, selectedEnvironmentId: () => "prod",
      loadSessions: vi.fn(), openSession: vi.fn(), isComposerAvailable: () => true,
    });
    const controller = createSessionController({
      state, preferences, selectedEnvironmentId: () => "prod",
      dom: { sessionsList: root, sessionsCount: new SidebarElement("span") },
      sessionActionsMenu: { reset: vi.fn() }, shell: {},
      confirmAction: vi.fn(), copyText: vi.fn(),
      onSidebarChange: () => { controller.render(); feature.publish(); },
    });
    controller.render();
    feature.sessionsChanged({ status: "ready", environmentId: "prod" });
    const archiveAction = () => allSidebarElements(root).find((element) =>
      element.querySelector(".session-open-button")?.id === "session-open-one" &&
      element.classList.contains("session-item"))!.querySelector(".archive-action")!;
    archiveAction().dispatch("click");
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [state.sessions[1]] }));
    root.querySelector(".session-archive-toggle")!.dispatch("click");
    archiveAction().dispatch("click");
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: state.sessions }));
  });

  test("one archive filter partitions sessions without changing source records or their order", () => {
    const sessions = [{ id: "first" }, { id: "archived" }, { id: "last" }];
    expect(filterSessionsByArchiveState(sessions, ["archived", "deleted"])).toEqual([sessions[0], sessions[2]]);
    expect(filterSessionsByArchiveState(sessions, ["archived"], true)).toEqual([sessions[1]]);
    expect(filterSessionsByArchiveState(sessions)).toEqual(sessions);
    expect(sessions).toHaveLength(3);
  });

  test("Home omits archived sessions and restores them on the next publication using the selected environment", () => {
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    let environmentId = "prod";
    const preferences = createClientPreferences(sidebarStorage());
    preferences.saveSessionSidebar("prod", { archivedSessionIds: ["one"], orderedSessionIds: [] });
    const state = { sessions: [{ id: "one", unreadCount: 5 }, { id: "two" }] };
    const feature = createDashboardFeature({
      state, preferences, dom: { homeDashboardRoot: {} },
      client: { supportsSchedules: () => false, supportsToolApprovals: () => false },
      shell: {}, schedules: {}, selectedEnvironmentId: () => environmentId,
      loadSessions: vi.fn(), openSession: vi.fn(), isComposerAvailable: () => true,
    });
    feature.sessionsChanged({ status: "ready", environmentId });
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [state.sessions[1]] }));
    expect(state.sessions).toHaveLength(2);
    preferences.saveSessionSidebar("prod", { archivedSessionIds: [], orderedSessionIds: [] });
    feature.publish();
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: state.sessions }));
    preferences.saveSessionSidebar("prod", { archivedSessionIds: ["one"], orderedSessionIds: [] });
    environmentId = "dev";
    feature.sessionsChanged({ status: "ready", environmentId });
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: state.sessions }));
    environmentId = "prod";
    feature.sessionsChanged({ status: "ready", environmentId });
    expect(dashboard.render).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [state.sessions[1]] }));
  });
});
