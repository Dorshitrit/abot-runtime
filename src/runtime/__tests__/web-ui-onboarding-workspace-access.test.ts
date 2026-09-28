import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createWorkspaceRouteController } from "../../web-ui/app/controllers/workspace-route-controller.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

const destinations = [
  ["chat", "chatWorkspaceButton"],
  ["learning", "learningWorkspaceButton"],
  ["memory", "memoryWorkspaceButton"],
  ["schedules", "schedulesWorkspaceButton"],
  ["models", "modelsWorkspaceButton"],
  ["plugins", "pluginsWorkspaceButton"],
  ["notifications", "notificationsWorkspaceButton"],
  ["config", "configWorkspaceButton"],
] as const;

function fixture(options: {
  width?: number;
  backendAllows?: (workspace: string) => boolean;
  beforeWorkspaceChange?: () => boolean | (() => void);
} = {}) {
  const harness = createWorkspaceShellHarness(options.width);
  const onWorkspaceChange = vi.fn();
  const shell = createWorkspaceShell({
    ...harness, onWorkspaceChange,
    isWorkspaceAvailable: options.backendAllows,
    beforeWorkspaceChange: options.beforeWorkspaceChange,
  });
  shell.bind(); shell.load();
  return { ...harness, shell, onWorkspaceChange };
}

function expectInitialSetupNavigation(f: ReturnType<typeof fixture>) {
  expect(f.shell.activeWorkspace()).toBe("home");
  expect(f.dom.homeWorkspacePanel.hidden).toBe(false);
  expect(f.dom.homeWorkspaceButton.disabled).toBe(false);
  expect(f.dom.homeWorkspaceButton.getAttribute("aria-current")).toBe("page");
  for (const [workspace, key] of destinations) {
    expect(f.shell.isWorkspaceAvailable(workspace)).toBe(false);
    expect(f.dom[key].disabled).toBe(true);
    expect(f.dom[key].getAttribute("aria-disabled")).toBe("true");
    expect(f.dom[key].dataset.onboardingBlocked).toBe("true");
    expect(f.dom[key].getAttribute("aria-description")).toBeTruthy();
  }
  expect(f.dom.learningWorkspaceButton.hidden).toBe(true);
  expect(f.dom.learningWorkspacePanel.hidden).toBe(true);
  expect(f.dom.learningWorkspacePanel.inert).toBe(true);
}

function routeFixture(path: string) {
  const f = fixture();
  f.shell.runtimeAvailabilityChanged({ status: "setup_required" });
  let environment = "fresh", session = "";
  const listeners = new Map<string, (event: { state: object }) => void>();
  const viewport = {
    ...f.viewport, location: new URL(path, "http://localhost:5177"),
    addEventListener: (type: string, callback: (event: { state: object }) => void) => listeners.set(type, callback),
    history: {
      state: {}, go: vi.fn(), pushState: vi.fn(),
      replaceState: vi.fn((state: object, _title: string, url: string) => {
        viewport.history.state = state;
        viewport.location = new URL(url, viewport.location);
      }),
    },
  };
  const loadSessions = vi.fn(async () => [{ id: "saved-chat" }]);
  const restoreLastSession = vi.fn(async () => {});
  const changeEnvironment = vi.fn(async (value: string) => {
    environment = value;
    f.shell.runtimeAvailabilityChanged({ status: value === "configured" ? "ready" : "setup_required" });
    return true;
  });
  const openSession = vi.fn(async (id: string, options: { commitRouteNavigation(): boolean }) => {
    if (options.commitRouteNavigation()) session = id;
  });
  const controller = createWorkspaceRouteController({
    viewport, shell: f.shell,
    configuration: { navigationRevision: () => 0, activateCategory: vi.fn() },
    schedules: { navigationRevision: () => 0, selectedJobId: () => "", openJob: vi.fn() },
    selection: { environmentOptions: () => [{ value: "fresh" }, { value: "configured" }] },
    getEnvironmentId: () => environment, getSessionId: () => session,
    changeEnvironment, loadSessions, openSession, restoreLastSession,
  });
  controller.bind();
  return { ...f, controller, viewport, loadSessions, openSession, restoreLastSession, changeEnvironment,
    visit(url: string) {
      viewport.location = new URL(url, viewport.location);
      listeners.get("popstate")!({ state: {} });
    },
  };
}

describe("initial onboarding workspace access", () => {
  test.each(["loading", "setup_required", "checking", "error"])(
    "%s before readiness leaves only Home available and hides Spark", (status) => {
      const f = fixture();
      f.shell.runtimeAvailabilityChanged({ status });
      expectInitialSetupNavigation(f);
      f.dom.homeWorkspaceButton.dispatch("click");
      expect(f.shell.activeWorkspace()).toBe("home");
    },
  );

  test.each(destinations)("blocks click, direct and prepared entry into %s", (workspace, key) => {
    const guard = vi.fn(() => true);
    const f = fixture({ beforeWorkspaceChange: guard });
    f.shell.runtimeAvailabilityChanged({ status: "setup_required" });
    f.dom[key].dispatch("click");
    expect(f.shell.activateWorkspace(workspace)).toBe(false);
    expect(f.shell.prepareWorkspaceActivation(workspace)).toBeNull();
    f.flushFrames();
    expect(f.shell.activeWorkspace()).toBe("home");
    expect(f.onWorkspaceChange).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  test("rechecks eligibility before committing a previously prepared navigation", () => {
    const commitDraftChange = vi.fn();
    const f = fixture({ beforeWorkspaceChange: () => commitDraftChange });
    f.shell.runtimeAvailabilityChanged({ status: "ready" });
    const activate = f.shell.prepareWorkspaceActivation("chat");
    expect(activate).toBeTypeOf("function");
    f.shell.runtimeAvailabilityChanged({ status: "setup_required" });
    expect(activate()).toBe(false);
    expect(commitDraftChange).not.toHaveBeenCalled();
    expect(f.shell.activeWorkspace()).toBe("home");
  });

  test.each([390, 1440])("blocks conversation drawer entry at width %i", (width) => {
    const f = fixture({ width });
    f.shell.runtimeAvailabilityChanged({ status: "loading" });
    expect(f.shell.setSessionsDrawerOpen(true)).toBe(false);
    f.dom.sessionsToggleButton.dispatch("click");
    f.flushFrames();
    expect(f.shell.activeWorkspace()).toBe("home");
    expect(f.dom.sessionsPanel.hidden).toBe(true);
    expect(f.dom.sessionsPanel.inert).toBe(true);
    expect(f.dom.panelBackdrop.getAttribute("aria-hidden")).toBe("true");
  });

  test("readiness unlocks the supported pages, removes blocked descriptions and reveals Spark", () => {
    const f = fixture();
    f.shell.runtimeAvailabilityChanged({ status: "setup_required" });
    f.shell.runtimeAvailabilityChanged({ status: "ready" });
    for (const [workspace, key] of destinations) {
      expect(f.shell.isWorkspaceAvailable(workspace)).toBe(true);
      expect(f.dom[key].disabled).toBe(false);
      expect(f.dom[key].getAttribute("aria-disabled")).toBe("false");
      expect(f.dom[key].dataset.onboardingBlocked).toBe("false");
      expect(f.dom[key].getAttribute("aria-description")).toBeNull();
    }
    expect(f.dom.learningWorkspaceButton.hidden).toBe(false);
    f.dom.learningWorkspaceButton.dispatch("click");
    expect(f.shell.activeWorkspace()).toBe("learning");
  });

  test.each(["ready", "setup_required"])("%s never enables a backend-unsupported page", (status) => {
    const f = fixture({ backendAllows: (workspace) => workspace !== "schedules" });
    f.shell.runtimeAvailabilityChanged({ status, recovery: "configuration" });
    expect(f.dom.schedulesWorkspaceButton.disabled).toBe(true);
    expect(f.dom.schedulesWorkspaceButton.dataset.onboardingBlocked).toBe("false");
    expect(f.shell.activateWorkspace("schedules")).toBe(false);
    expect(f.shell.prepareWorkspaceActivation("schedules")).toBeNull();
  });

  test("configuration recovery can reach Models and System even when setup is required", () => {
    const f = fixture();
    f.shell.runtimeAvailabilityChanged({ status: "setup_required" });
    f.shell.runtimeAvailabilityChanged({ status: "setup_required", recovery: "configuration" });
    f.dom.modelsWorkspaceButton.dispatch("click");
    expect(f.shell.activeWorkspace()).toBe("models");
    expect(f.dom.configWorkspacePanel.hidden).toBe(false);
    f.dom.configWorkspaceButton.dispatch("click");
    expect(f.shell.activeWorkspace()).toBe("config");
  });

  test("checking and network errors after readiness preserve the selected workspace and access", () => {
    const f = fixture();
    f.shell.runtimeAvailabilityChanged({ status: "ready" });
    f.shell.activateWorkspace("learning");
    for (const status of ["checking", "error"]) {
      f.shell.runtimeAvailabilityChanged({ status });
      expect(f.shell.activeWorkspace()).toBe("learning");
      expect(f.dom.learningWorkspaceButton.hidden).toBe(false);
      for (const [workspace] of destinations) expect(f.shell.isWorkspaceAvailable(workspace)).toBe(true);
    }
  });

  test.each(["chat", "learning", "models"])("new setup requirement closes %s and returns Home", (workspace) => {
    const f = fixture();
    f.shell.runtimeAvailabilityChanged({ status: "ready" });
    f.shell.activateWorkspace(workspace);
    if (workspace === "chat") f.shell.setSessionsDrawerOpen(true);
    f.shell.runtimeAvailabilityChanged({ status: "setup_required" });
    f.flushFrames();
    expectInitialSetupNavigation(f);
    expect(f.dom.sessionsPanel.hidden).toBe(true);
    expect(f.dom.configWorkspacePanel.hidden).toBe(true);
    expect(f.onWorkspaceChange).toHaveBeenLastCalledWith("home");
  });
});

describe("onboarding through real URL restoration", () => {
  test.each(["/learning", "/chat?session=saved-chat"])("blocked initial URL %s returns Home without loading conversations", async (path) => {
    const f = routeFixture(path);
    await f.controller.restoreInitial();
    expectInitialSetupNavigation(f);
    expect(f.viewport.location.pathname).toBe("/home");
    expect(f.viewport.location.searchParams.get("session")).toBeNull();
    expect(f.loadSessions).not.toHaveBeenCalled();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.restoreLastSession).not.toHaveBeenCalled();
    expect(f.changeEnvironment).not.toHaveBeenCalled();
  });

  test("popstate can switch out of onboarding before checking target workspace access", async () => {
    const f = routeFixture("/learning");
    await f.controller.restoreInitial();
    f.visit("/chat?environment=configured&session=saved-chat");
    await vi.waitFor(() => expect(f.shell.activeWorkspace()).toBe("chat"));
    expect(f.changeEnvironment).toHaveBeenCalledExactlyOnceWith("configured", { restoreSession: false });
    expect(f.loadSessions).toHaveBeenCalledOnce();
    expect(f.openSession).toHaveBeenCalledWith("saved-chat", expect.any(Object));
    expect(f.viewport.location.pathname).toBe("/chat");
    expect(f.viewport.location.searchParams.get("environment")).toBe("configured");
    expect(f.viewport.location.searchParams.get("session")).toBe("saved-chat");
    expect(f.dom.chatWorkspaceButton.disabled).toBe(false);
  });
});
