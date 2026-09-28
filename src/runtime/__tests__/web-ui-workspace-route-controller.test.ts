import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createWorkspaceRouteController } from "../../web-ui/app/controllers/workspace-route-controller.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { configurationCategoryForWorkspace } from "../../web-ui/app/lib/configuration-pages.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

type RouteHistory = { url: string; state: { abotWorkspaceIndex?: number } };
type RouteOpenOptions = {
  isRouteCurrent(): boolean;
  commitRouteNavigation(): boolean;
};
async function settle() {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
}

function createHarness(
  path = "/home",
  nativeSchedules = true,
  previousEntries: RouteHistory[] = [],
) {
  const harness = createWorkspaceShellHarness(1440);
  const listeners = new Map<string, (event: { state: object }) => void>();
  const entries: RouteHistory[] = previousEntries.length
    ? previousEntries
    : [{ url: path, state: {} }];
  let position = entries.length - 1;
  let environment = "dev";
  let sessionId = "";
  let category = "models";
  let selectedJob = "";
  let configurationRevision = 0;
  let scheduleRevision = 0;
  let allowWorkspace = true;
  let allowEnvironment = true;
  let environmentChanging = false;
  let controller: ReturnType<typeof createWorkspaceRouteController>;
  const viewport = {
    ...harness.viewport,
    location: new URL(path, "http://localhost:5177"),
    addEventListener: (
      name: string,
      callback: (event: { state: object }) => void,
    ) => listeners.set(name, callback),
    history: {
      get state() {
        return entries[position].state;
      },
      replaceState: vi.fn(
        (state: RouteHistory["state"], _title: string, url: string) => {
          entries[position] = { state, url };
          viewport.location = new URL(url, viewport.location);
        },
      ),
      pushState: vi.fn(
        (state: RouteHistory["state"], _title: string, url: string) => {
          entries.splice(position + 1);
          entries.push({ state, url });
          position += 1;
          viewport.location = new URL(url, viewport.location);
        },
      ),
      go: vi.fn((delta: number) => {
        position += delta;
        viewport.location = new URL(entries[position].url, viewport.location);
        listeners.get("popstate")?.({ state: entries[position].state });
      }),
    },
  };
  const onNavigationChange = () => controller?.sync();
  const shell = createWorkspaceShell({
    ...harness,
    viewport,
    beforeWorkspaceChange: () => allowWorkspace,
    isWorkspaceAvailable: (workspace: string) =>
      workspace !== "schedules" || nativeSchedules,
    onWorkspaceChange: (workspace: string) => {
      const nextCategory = configurationCategoryForWorkspace(workspace);
      if (nextCategory) configuration.activateCategory(nextCategory);
      onNavigationChange();
    },
    onNavigationChange,
  });
  shell.load();
  shell.bind();
  const configuration = {
    activeCategory: () => category,
    navigationRevision: () => configurationRevision,
    activateCategory: (value: string) => {
      category = value;
      configurationRevision += 1;
      onNavigationChange();
    },
  };
  const loadSessions = vi.fn(async () => [
    { id: "session-a" },
    { id: "session-b" },
  ]);
  const openSession = vi.fn(async (id: string, options?: RouteOpenOptions) => {
    if (options && !options.isRouteCurrent()) return;
    if (options && !options.commitRouteNavigation()) return;
    sessionId = id;
    onNavigationChange();
  });
  const restoreLastSession = vi.fn(async () => {
    sessionId = "session-a";
    onNavigationChange();
  });
  const changeEnvironment = vi.fn(async (value: string) => {
    if (!allowEnvironment) return false;
    environment = value;
    sessionId = "";
    return true;
  });
  const schedules = {
    isWorkspaceAvailable: (workspace: string) =>
      workspace !== "schedules" || nativeSchedules,
    selectedJobId: () => selectedJob,
    navigationRevision: () => scheduleRevision,
    openJob: vi.fn(async (value: string) => {
      selectedJob = value;
      scheduleRevision += 1;
      onNavigationChange();
      return true;
    }),
  };
  controller = createWorkspaceRouteController({
    viewport,
    shell,
    configuration,
    schedules,
    selection: {
      environmentOptions: () => [{ value: "dev" }, { value: "prod" }],
    },
    getEnvironmentId: () => environment,
    getSessionId: () => sessionId,
    changeEnvironment,
    isEnvironmentChanging: () => environmentChanging,
    loadSessions,
    openSession,
    restoreLastSession,
  });
  controller.bind();
  return {
    ...harness,
    controller,
    viewport,
    shell,
    configuration,
    schedules,
    loadSessions,
    openSession,
    restoreLastSession,
    changeEnvironment,
    entries,
    setEnvironment: (value: string) => {
      environment = value;
    },
    setSession: (value: string) => {
      sessionId = value;
    },
    setEnvironmentChanging: (value: boolean) => {
      environmentChanging = value;
    },
    allowWorkspace: (value: boolean) => {
      allowWorkspace = value;
    },
    allowEnvironment: (value: boolean) => {
      allowEnvironment = value;
    },
    address: () => viewport.location.pathname + viewport.location.search,
    async start() {
      environment = controller.bootstrapEnvironment(
        [{ value: "dev" }, { value: "prod" }],
        "dev",
        "prod",
      );
      await controller.restoreInitial();
      await settle();
    },
    async visit(url: string) {
      viewport.history.pushState(
        { abotWorkspaceIndex: entries.length },
        "",
        url,
      );
      listeners.get("popstate")?.({ state: viewport.history.state });
      await settle();
    },
  };
}

async function waitForChatRoute(f: ReturnType<typeof createHarness>) {
  let finishLoading!: (sessions: { id: string }[]) => void;
  f.loadSessions.mockImplementation(
    () => new Promise((resolve) => (finishLoading = resolve)),
  );
  await f.visit("/chat?environment=dev&session=session-b");
  return () => finishLoading([{ id: "session-b" }]);
}

describe("Web UI route restoration", () => {
  test("restores Learning directly without restoring a background conversation as its target", async () => {
    const f = createHarness("/learning?environment=prod&session=session-b");
    await f.start();
    expect(f.shell.activeWorkspace()).toBe("learning");
    expect(f.dom.learningWorkspacePanel.hidden).toBe(false);
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.address()).toBe("/learning?environment=prod");
  });

  test("restores environment and configuration views without treating a background conversation as a route target", async () => {
    const f = createHarness(
      "/config?environment=prod&session=session-b&category=plugins&tab=logs",
    );
    await f.start();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.restoreLastSession).toHaveBeenCalledOnce();
    expect(f.shell.activeWorkspace()).toBe("plugins");
    expect(f.dom.configWorkspacePanel.hidden).toBe(false);
    expect(f.configuration.activeCategory()).toBe("plugins");
    expect(f.shell.activeOperationsTab()).toBe("runtime");
    expect(f.address()).toBe("/plugins?environment=prod");
    expect(f.viewport.history.pushState).not.toHaveBeenCalled();
  });

  test("defers browser navigation until bootstrap data is ready and restores the latest address", async () => {
    const f = createHarness("/home");
    await f.visit("/config?environment=prod&category=plugins&tab=logs");
    expect(f.restoreLastSession).not.toHaveBeenCalled();
    expect(f.shell.activeWorkspace()).toBe("home");
    await f.start();
    expect(f.shell.activeWorkspace()).toBe("plugins");
    expect(f.address()).toBe("/plugins?environment=prod");
    expect(f.viewport.history.state.abotWorkspaceIndex).toBe(1);
  });

  test("restores an exact Chat conversation before revealing Chat", async () => {
    const f = createHarness("/chat?environment=prod&session=session-b");
    f.openSession.mockImplementation(async () => {
      expect(f.shell.activeWorkspace()).toBe("home");
      await Promise.resolve();
    });
    await f.start();
    expect(f.openSession).toHaveBeenCalledExactlyOnceWith(
      "session-b",
      expect.objectContaining({
        isRouteCurrent: expect.any(Function),
        commitRouteNavigation: expect.any(Function),
      }),
    );
    expect(f.restoreLastSession).not.toHaveBeenCalled();
    // A session opener that refuses to change identity cannot commit navigation.
    expect(f.shell.activeWorkspace()).toBe("home");
  });

  test("does not restore an unavailable environment's job into the fallback environment", async () => {
    const f = createHarness("/schedules?environment=deleted&job=job-1");
    await f.start();
    expect(f.schedules.openJob).toHaveBeenCalledExactlyOnceWith("");
    expect(f.address()).toBe("/schedules?environment=dev");
  });

  test("a schedules landing address clears a previous selected job", async () => {
    const f = createHarness("/schedules?environment=dev&job=job-1");
    await f.start();
    await f.visit("/schedules?environment=dev");
    expect(f.schedules.openJob).toHaveBeenLastCalledWith("");
    expect(f.address()).toBe("/schedules?environment=dev");
  });

  test("changes the address after sidebar navigation and restores Back and Forward", async () => {
    const f = createHarness();
    await f.start();
    f.dom.modelsWorkspaceButton.dispatch("click");
    await settle();
    f.dom.configWorkspaceButton.dispatch("click");
    f.shell.activateOperationsTab("health");
    await settle();
    expect(f.entries).toHaveLength(3);
    f.viewport.history.go(-1);
    await settle();
    expect(f.configuration.activeCategory()).toBe("models");
    expect(f.address()).toBe("/models?environment=dev");
    f.viewport.history.go(-1);
    await settle();
    expect(f.shell.activeWorkspace()).toBe("home");
    f.viewport.history.go(2);
    await settle();
    expect(f.configuration.activeCategory()).toBe("operations");
    expect(f.shell.activeOperationsTab()).toBe("health");
  });

  test("canceled Back preserves the guarded screen and history entries", async () => {
    const f = createHarness();
    await f.start();
    f.shell.activateWorkspace("config");
    await settle();
    const address = f.address();
    f.allowWorkspace(false);
    f.viewport.history.go(-1);
    await settle();
    expect(f.address()).toBe(address);
    expect(f.shell.activeWorkspace()).toBe("config");
    expect(f.viewport.history.go).toHaveBeenLastCalledWith(1);
    f.allowWorkspace(true);
    f.viewport.history.go(-1);
    await settle();
    expect(f.shell.activeWorkspace()).toBe("home");
  });

  test("preserves history identity across a reload before canceling Back", async () => {
    const f = createHarness(
      "/models?environment=dev",
      true,
      [
        { url: "/home?environment=dev", state: { abotWorkspaceIndex: 4 } },
        {
          url: "/models?environment=dev",
          state: { abotWorkspaceIndex: 5 },
        },
      ],
    );
    await f.start();
    expect(f.viewport.history.state.abotWorkspaceIndex).toBe(5);
    f.allowWorkspace(false);
    f.viewport.history.go(-1);
    await settle();
    expect(f.viewport.history.go).toHaveBeenLastCalledWith(1);
    expect(f.viewport.history.state.abotWorkspaceIndex).toBe(5);
    expect(f.shell.activeWorkspace()).toBe("models");
  });

  test("does not create intermediate history entries while an environment refresh is pending", async () => {
    const f = createHarness();
    await f.start();
    f.setEnvironmentChanging(true);
    f.setEnvironment("prod");
    f.controller.sync();
    await settle();
    expect(f.entries).toHaveLength(1);
    f.setEnvironmentChanging(false);
    f.controller.sync();
    await settle();
    expect(f.entries).toHaveLength(2);
    expect(f.address()).toBe("/home?environment=prod");
  });

  test("a session list from an older environment cannot activate its linked conversation", async () => {
    const f = createHarness();
    await f.start();
    f.loadSessions.mockImplementation(async () => {
      f.setEnvironment("prod");
      return [{ id: "session-b" }];
    });
    await f.visit("/chat?environment=dev&session=session-b");
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.shell.activeWorkspace()).toBe("home");
    expect(f.address()).toBe("/home?environment=prod");
  });

  test("manual workspace navigation cancels a linked route waiting for sessions", async () => {
    const f = createHarness();
    await f.start();
    let finishLoading!: (sessions: { id: string }[]) => void;
    f.loadSessions.mockImplementation(
      () => new Promise((resolve) => (finishLoading = resolve)),
    );

    await f.visit("/chat?environment=dev&session=session-b");
    expect(f.loadSessions).toHaveBeenCalledOnce();
    f.shell.activateWorkspace("config");
    finishLoading([{ id: "session-b" }]);
    await settle();

    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.shell.activeWorkspace()).toBe("config");
    expect(f.address()).toBe("/system?environment=dev&tab=runtime");
  });

  test.each([
    {
      source: "/models?environment=dev",
      navigate: (f: ReturnType<typeof createHarness>) =>
        f.configuration.activateCategory("models"),
      expected: "/models?environment=dev",
    },
    {
      source: "/schedules?environment=dev&job=job-1",
      navigate: (f: ReturnType<typeof createHarness>) =>
        f.schedules.openJob("job-2"),
      expected: "/schedules?environment=dev&job=job-2",
    },
  ])("sub-workspace selection cancels $source", async (scenario) => {
    const f = createHarness(scenario.source);
    await f.start();
    const finishLoading = await waitForChatRoute(f);
    await scenario.navigate(f);
    finishLoading();
    await settle();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.address()).toBe(scenario.expected);
  });

  test("schedule background refresh does not cancel a pending route", async () => {
    const f = createHarness("/schedules?environment=dev&job=job-1");
    await f.start();
    const finishLoading = await waitForChatRoute(f);
    f.controller.sync();
    finishLoading();
    await settle();
    expect(f.shell.activeWorkspace()).toBe("chat");
    expect(f.address()).toBe("/chat?environment=dev&session=session-b");
  });

  test("manual workspace navigation cancels initial restoration waiting for a conversation", async () => {
    const f = createHarness("/chat?environment=dev&session=session-b");
    let finishOpening!: () => void;
    f.openSession.mockImplementation(async (sessionId, options) => {
      await new Promise<void>((resolve) => (finishOpening = resolve));
      if (!options?.isRouteCurrent()) return;
      if (!options.commitRouteNavigation()) return;
      f.setSession(sessionId);
    });

    const starting = f.start();
    await settle();
    expect(f.openSession).toHaveBeenCalledExactlyOnceWith(
      "session-b",
      expect.objectContaining({
        isRouteCurrent: expect.any(Function),
        commitRouteNavigation: expect.any(Function),
      }),
    );
    f.shell.activateWorkspace("config");
    finishOpening();
    await starting;

    expect(f.shell.activeWorkspace()).toBe("config");
    expect(f.address()).not.toContain("session=session-b");
    expect(f.address()).toBe("/system?environment=dev&tab=runtime");
  });

  test("linked history route commits Chat only after its conversation loads", async () => {
    const f = createHarness();
    await f.start();
    let finishOpening!: () => void;
    f.openSession.mockImplementation(async (sessionId, options) => {
      await new Promise<void>((resolve) => (finishOpening = resolve));
      if (!options?.isRouteCurrent()) return;
      if (!options.commitRouteNavigation()) return;
      f.setSession(sessionId);
    });

    await f.visit("/chat?environment=dev&session=session-b");
    expect(f.shell.activeWorkspace()).toBe("home");
    finishOpening();
    await settle();

    expect(f.shell.activeWorkspace()).toBe("chat");
    expect(f.address()).toBe("/chat?environment=dev&session=session-b");
  });

  test("checks environment guards before restoring a linked session", async () => {
    const f = createHarness("/chat?environment=dev&session=session-a");
    await f.start();
    f.allowEnvironment(false);
    await f.visit("/chat?environment=prod&session=session-b");
    expect(f.changeEnvironment).toHaveBeenCalledWith("prod", {
      restoreSession: false,
    });
    expect(f.openSession).toHaveBeenCalledTimes(1);
    expect(f.address()).toBe("/chat?environment=dev&session=session-a");
  });

  test("restores saved schedule details and respects native backend availability", async () => {
    const native = createHarness("/schedules?environment=dev&job=job-1");
    await native.start();
    expect(native.schedules.openJob).toHaveBeenCalledExactlyOnceWith("job-1");
    expect(native.shell.activeWorkspace()).toBe("schedules");
    expect(native.address()).toContain("job=job-1");
    const bridge = createHarness("/schedules?environment=dev&job=job-1", false);
    await bridge.start();
    expect(bridge.schedules.openJob).not.toHaveBeenCalled();
    expect(bridge.shell.activeWorkspace()).toBe("home");
  });

  test("unknown environment cannot load a same-named conversation from the fallback environment", async () => {
    const f = createHarness("/chat?environment=deleted&session=session-b");
    await f.start();
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.restoreLastSession).toHaveBeenCalledOnce();
    expect(f.address()).toBe("/chat?environment=dev&session=session-a");
  });

  test("missing conversations never call openSession or replace the visible workspace", async () => {
    const f = createHarness();
    await f.start();
    await f.visit("/chat?environment=dev&session=missing");
    expect(f.openSession).not.toHaveBeenCalled();
    expect(f.shell.activeWorkspace()).toBe("home");
  });
});
