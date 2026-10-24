import { expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { createWorkspaceRouteController } from "../../web-ui/app/controllers/workspace-route-controller.js";
// @ts-expect-error Browser module.
import { createSessionListPagination } from "../../web-ui/app/controllers/session-list-pagination.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function fixture(path: string) {
  const f = createPlanLifecycleHarness({ messages: [{ id: 21, role: "assistant", text: "Linked conversation" }], requests: [] });
  let workspace = "home";
  let revision = 0;
  const listeners = new Map<string, (event: object) => void>();
  const viewport = {
    location: new URL(path, "http://localhost"),
    history: { state: {}, replaceState: vi.fn(), pushState: vi.fn() },
    addEventListener: (name: string, listener: (event: object) => void) => listeners.set(name, listener),
  };
  const shell = {
    activeWorkspace: () => workspace, activeOperationsTab: () => "", navigationRevision: () => revision,
    isWorkspaceAvailable: () => true, isWorkspaceSupportedByBackend: () => true,
    prepareWorkspaceActivation: (target: string) => () => { workspace = target; revision++; return true; },
    showToast: vi.fn(),
  };
  const sessionPageClient = { listSessions: vi.fn(async (_environment: string, options: { cursor?: string }) => {
    const offset = Number(options.cursor ?? 0);
    return { sessions: Array.from({ length: 20 }, (_, index) => ({ id: "recent-" + (offset + index) })), nextCursor: String(offset + 20) };
  }) };
  const pagination = createSessionListPagination({
    state: f.state, dom: { sessionsList: {} }, client: sessionPageClient, sessions: {},
    selectedEnvironmentId: () => "dev", renderSessions: vi.fn(), onSessionListState: vi.fn(),
  });
  const loadSessions = vi.fn(() => pagination.load());
  const controller = createWorkspaceRouteController({
    viewport, shell, configuration: { navigationRevision: () => 0 },
    schedules: { navigationRevision: () => 0, selectedJobId: () => "" },
    selection: { environmentOptions: () => [{ value: "dev" }] },
    getEnvironmentId: () => "dev", getSessionId: () => f.state.currentSessionId,
    loadSessions, openSession: f.conversationSession.openSession, restoreLastSession: vi.fn(),
  });
  controller.bind();
  return { ...f, controller, viewport, shell, loadSessions, pagination, sessionPageClient, async visit(path: string) {
    viewport.location = new URL(path, viewport.location);
    listeners.get("popstate")!({ state: {} });
    for (let i = 0; i < 30; i++) await Promise.resolve();
  } };
}

test.each(["initial", "history"])("%s route opens a session outside the first page with one bounded session read", async (mode) => {
  const path = "/chat?environment=dev&session=older-session";
  const f = fixture(mode === "initial" ? path : "/home");
  await f.controller.restoreInitial();
  if (mode === "history") await f.visit(path);
  expect(f.loadSessions).toHaveBeenCalledOnce();
  expect(f.client.loadSession).toHaveBeenCalledExactlyOnceWith("older-session", "dev", { waitingRequestId: undefined });
  expect(f.state.currentSessionId).toBe("older-session");
  expect(f.shell.activeWorkspace()).toBe("chat");
  expect(f.shell.showToast).not.toHaveBeenCalled();
});

test("a missing routed session leaves the visible conversation and workspace intact", async () => {
  const f = fixture("/chat?environment=dev&session=missing");
  const previous = f.state.messages;
  f.client.loadSession.mockRejectedValueOnce(Object.assign(new Error("session_not_found"), { code: "session_not_found" }));
  await f.controller.restoreInitial();
  expect(f.state.currentSessionId).toBe("session-1");
  expect(f.state.messages).toBe(previous);
  expect(f.shell.activeWorkspace()).toBe("home");
  expect(f.shell.showToast).toHaveBeenCalledWith("This conversation is unavailable in the selected environment.", "failed");
});

test("same-environment conversation navigation retains loaded sidebar pages", async () => {
  const f = fixture("/chat?environment=dev&session=older-session");
  await f.controller.restoreInitial();
  await f.pagination.load(true);
  expect(f.state.sessions).toHaveLength(40);
  f.loadSessions.mockClear();
  const sessions = f.state.sessions;
  await f.visit("/chat?environment=dev&session=another-session");
  expect(f.state.currentSessionId).toBe("another-session");
  expect(f.loadSessions).not.toHaveBeenCalled();
  expect(f.state.sessions).toBe(sessions);
  expect(f.shell.activeWorkspace()).toBe("chat");
  await f.pagination.load(true);
  expect(f.sessionPageClient.listSessions).toHaveBeenLastCalledWith("dev", { cursor: "40", query: "" });
  expect(f.state.sessions).toHaveLength(60);
});
