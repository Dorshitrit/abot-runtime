import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createNotificationsFeature } from "../../web-ui/app/notifications-feature.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createWorkspaceRouteController } from "../../web-ui/app/controllers/workspace-route-controller.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

const workspace = vi.hoisted(() => ({ create: vi.fn(), render: vi.fn() }));
vi.mock("../../web-ui/app/components/notifications/dom.js", () => ({
  mountNotificationsDom: vi.fn(),
}));
vi.mock("../../web-ui/app/components/notifications/workspace.js", () => ({
  createNotificationsWorkspace: workspace.create,
}));
vi.mock("../../web-ui/app/components/notifications/home-entry.js", () => ({
  createHomeNotificationsEntry: () => ({ render: vi.fn() }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const notice = {
  id: "notice", kind: "reply", environmentId: "dev", sessionId: "chat-a",
  sourceUrl: "/chat?environment=dev&session=chat-a", readAt: null,
};

function createFixture(backend: string | undefined = "runtime") {
  const harness = createWorkspaceShellHarness();
  let environment = "dev";
  let available = backend === "runtime";
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { assign } });
  vi.stubGlobal("document", { visibilityState: "visible" });
  workspace.create.mockReturnValue({ render: workspace.render });
  const client = {
    supportsNotifications: () => available,
    listNotifications: vi.fn(async () => ({
      items: [{ ...notice, environmentId: environment }], unreadCount: 1,
    })),
    markNotificationsRead: vi.fn(async () => {}),
  };
  let feature: ReturnType<typeof createNotificationsFeature>;
  const shell = createWorkspaceShell({
    ...harness,
    isWorkspaceAvailable: (destination: string) => feature.isWorkspaceAvailable(destination),
    onWorkspaceChange: (destination: string) => feature.workspaceChanged(destination),
  });
  feature = createNotificationsFeature({
    dom: harness.dom, state: { connected: false }, client, shell,
    getEnvironmentId: () => environment, send: vi.fn(),
  });
  shell.load();
  shell.bind();
  return {
    ...harness, client, shell, feature, assign,
    open: () => workspace.create.mock.calls.at(-1)![0].actions.openSource(notice),
    environment: () => environment,
    setBackend(value: string) {
      available = value === "runtime";
      feature.refreshAvailability();
    },
    setEnvironment(value: string) {
      environment = value;
      feature.environmentChanged();
    },
  };
}

describe("notification backend navigation", () => {
  test.each(["bridge", "unconfigured"])("%s hides and rejects the notification workspace", async (backend) => {
    const f = createFixture(backend);
    await f.feature.setReady();
    expect(f.dom.notificationsWorkspaceButton.hidden).toBe(true);
    expect(f.dom.notificationsWorkspaceButton.disabled).toBe(true);
    expect(f.shell.activateWorkspace("notifications")).toBe(false);
    expect(f.shell.prepareWorkspaceActivation("notifications")).toBeNull();
    f.dom.notificationsWorkspaceButton.dispatch("click");
    expect(f.dom.notificationsWorkspacePanel.hidden).toBe(true);
    expect(f.client.listNotifications).not.toHaveBeenCalled();
    expect(f.shell.activateWorkspace("config")).toBe(true);
  });

  test("bootstrap enables native navigation and a backend change invalidates prepared and active views", async () => {
    const f = createFixture("unconfigured");
    f.setBackend("runtime");
    await f.feature.setReady();
    expect(f.dom.notificationsWorkspaceButton.hidden).toBe(false);
    expect(f.dom.notificationsWorkspaceButton.disabled).toBe(false);
    const commit = f.shell.prepareWorkspaceActivation("notifications");
    f.setBackend("bridge");
    expect(commit()).toBe(false);
    f.setBackend("runtime");
    expect(f.shell.activateWorkspace("notifications")).toBe(true);
    f.setBackend("bridge");
    expect(f.shell.activeWorkspace()).toBe("chat");
    expect(f.dom.notificationsWorkspacePanel.hidden).toBe(true);
    expect(f.dom.notificationsWorkspaceButton.hidden).toBe(true);
  });

  test.each([undefined, "setup_required"])("a Bridge startup deep link is rejected before environment or conversation changes during %s", async (status) => {
    const f = createFixture("bridge");
    if (status) f.shell.runtimeAvailabilityChanged({ status });
    const replaceState = vi.fn();
    const changeEnvironment = vi.fn();
    const restoreLastSession = vi.fn();
    const routes = createWorkspaceRouteController({
      viewport: {
        location: new URL("http://localhost/notifications?environment=prod"),
        history: { state: {}, replaceState },
      },
      shell: f.shell,
      configuration: { activeCategory: () => "models", navigationRevision: () => 0 },
      selection: { environmentOptions: () => [{ value: "dev" }, { value: "prod" }] },
      schedules: { selectedJobId: () => "", navigationRevision: () => 0 },
      getEnvironmentId: f.environment, getSessionId: () => "",
      changeEnvironment, restoreLastSession, loadSessions: vi.fn(), openSession: vi.fn(),
    });
    await routes.restoreInitial();
    expect(f.shell.activeWorkspace()).toBe("home");
    expect(changeEnvironment).not.toHaveBeenCalled();
    expect(restoreLastSession).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(expect.anything(), "", "/home?environment=dev");
    expect(f.client.listNotifications).not.toHaveBeenCalled();
  });
});

describe("notification source opening", () => {
  test("opens its source even when marking the notification read rejects", async () => {
    const f = createFixture();
    await f.feature.setReady();
    f.shell.activateWorkspace("notifications");
    f.client.markNotificationsRead.mockRejectedValueOnce(new Error("Read update failed"));
    await f.open();
    expect(f.client.markNotificationsRead).toHaveBeenCalledWith({ ids: ["notice"], read: true }, "dev");
    expect(f.assign).toHaveBeenCalledWith(notice.sourceUrl);
    expect(f.feature.snapshot().error).toBe("Read update failed");
  });

  test.each(["environment", "navigation", "backend"])("does not reopen an old source after %s changes during the read", async (change) => {
    const f = createFixture();
    await f.feature.setReady();
    f.shell.activateWorkspace("notifications");
    let rejectRead!: (error: Error) => void;
    f.client.markNotificationsRead.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; }));
    const pending = f.open();
    if (change === "environment") {
      f.setEnvironment("prod");
      f.setEnvironment("dev");
    }
    if (change === "navigation") {
      f.shell.activateWorkspace("home");
      f.shell.activateWorkspace("notifications");
    }
    if (change === "backend") f.setBackend("bridge");
    rejectRead(new Error("Late read failure"));
    await pending;
    expect(f.assign).not.toHaveBeenCalled();
  });
});
