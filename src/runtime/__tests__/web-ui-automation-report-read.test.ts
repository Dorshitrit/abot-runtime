import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createAutomationsFeature } from "../../web-ui/app/automations-feature.js";
import { createNotificationRequests } from "../../web-ui/app/services/runtime-web-client/notifications.js";

const view = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../../web-ui/app/components/automations/workspace.js", () => ({
  createAutomationsWorkspace: () => ({ render: view.render, isDirty: () => false, prepareLeave: () => true }),
}));
// Chat report behavior is covered with its real rendering owner in chat-run-refresh.
vi.mock("../../web-ui/app/components/automations/chat-run-projection.js", () => ({
  createAutomationChatRunProjection: () => ({ clear() {}, workspaceChanged() {}, visibilityChanged() {},
    handleRealtime() {}, reconnect() {}, runId: () => "" }),
}));

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
function fixture() {
  let environment = "dev", workspace = "home", status = "running";
  let onWorkspace: (value: string) => void = () => {};
  let onRealtime: (value: unknown) => void = () => {};
  const events = new Map<string, () => void>();
  const documentRoot = { visibilityState: "visible", addEventListener: (name: string, handler: () => void) => events.set(name, handler) };
  const element = { addEventListener() {}, dataset: {} };
  const dom = { automationsRoot: {}, automationsWorkspaceButton: element, automationChatRunPanel: {},
    chatWorkspaceButton: element, environmentSelect: element };
  const client = {
    supportsAutomations: () => true, supportsNotifications: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "automation-1" }] })),
    getAutomationCatalog: vi.fn(async () => ({})),
    getAutomationDraft: vi.fn(async () => ({ draft: null })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    getAutomationRun: vi.fn(async (id: string) => ({ run: { id, automationId: "automation-1", status } })),
    markAutomationReportRead: vi.fn(async () => ({ ok: true })),
  };
  const feature = createAutomationsFeature({ dom, client, documentRoot, getEnvironmentId: () => environment,
    shell: { activeWorkspace: () => workspace, addWorkspaceGuard() {},
      subscribeWorkspaceChange: (handler: typeof onWorkspace) => { onWorkspace = handler; } },
    realtime: { subscribeMessages: (handler: typeof onRealtime) => { onRealtime = handler; } },
  });
  return { feature, client,
    activate(value: string) { workspace = value; onWorkspace(value); },
    visibility(value: string) { documentRoot.visibilityState = value; events.get("visibilitychange")?.(); },
    setEnvironment(value: string) { environment = value; },
    async finish(nextStatus: string) {
      status = nextStatus;
      onRealtime({ type: "event", name: "automation.run.finished", environment, runId: "run-1" });
      await vi.advanceTimersByTimeAsync(80);
    },
  };
}

test("Studio marks only a rendered visible run; list, editor, preload and hidden completion stay unread", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.feature.openRoute("", "");
  await f.feature.openRoute("automation-1", "");
  await f.feature.openRoute("automation-1", "run-1");
  expect(f.client.markAutomationReportRead).not.toHaveBeenCalled();
  f.activate("automations");
  expect(view.render).toHaveBeenLastCalledWith(expect.objectContaining({ run: expect.objectContaining({ id: "run-1" }) }));
  expect(f.client.markAutomationReportRead).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", phase: "started" }, "dev");
  await f.finish("running");
  expect(f.client.markAutomationReportRead).toHaveBeenCalledTimes(1);
  f.visibility("hidden");
  await f.finish("succeeded");
  expect(f.client.markAutomationReportRead).toHaveBeenCalledTimes(1);
  f.visibility("visible");
  await vi.advanceTimersByTimeAsync(80);
  expect(f.client.markAutomationReportRead).toHaveBeenLastCalledWith({ runId: "run-1", phase: "finished" }, "dev");
  const before = f.client.markAutomationReportRead.mock.calls.length;
  await f.finish("succeeded");
  expect(f.client.markAutomationReportRead).toHaveBeenCalledTimes(before);
});

test("Studio rejects stale environment reads and failed loads without blocking navigation", async () => {
  const f = fixture();
  f.activate("automations");
  await f.feature.openRoute("automation-1", "run-1");
  f.client.markAutomationReportRead.mockClear();
  f.setEnvironment("prod");
  f.visibility("hidden"); f.visibility("visible");
  expect(f.client.markAutomationReportRead).not.toHaveBeenCalled();
  f.client.getAutomationRun.mockRejectedValueOnce(new Error("cannot load"));
  await f.feature.openRoute("automation-1", "run-2");
  expect(f.client.markAutomationReportRead).not.toHaveBeenCalled();
  f.client.markAutomationReportRead.mockRejectedValueOnce(new Error("storage unavailable"));
  await f.feature.openRoute("automation-1", "run-3");
  expect(f.client.markAutomationReportRead).toHaveBeenCalledWith({ runId: "run-3", phase: "started" }, "prod");
});

test("the browser sends only an explicit run phase to the notification mutation route", async () => {
  const requestApi = vi.fn(async () => ({ ok: true }));
  const client = createNotificationRequests({ requestApi, getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "prod" });
  await client.markAutomationReportRead({ runId: "run-1", phase: "finished" }, "dev");
  expect(requestApi).toHaveBeenCalledExactlyOnceWith("/notifications/automation-report-read", {
    method: "POST", body: JSON.stringify({ runId: "run-1", phase: "finished", environment: "dev" }),
  });
});
