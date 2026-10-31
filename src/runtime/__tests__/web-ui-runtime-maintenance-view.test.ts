import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser controller module.
import { createRuntimeMaintenanceController } from "../../web-ui/app/controllers/runtime-maintenance-controller.js";
// @ts-expect-error Browser feature module.
import { createRuntimeMaintenanceFeature } from "../../web-ui/app/runtime-maintenance-feature.js";
// @ts-expect-error Browser view reconciliation.
import { reconcileRuntimeSessionReset } from "../../web-ui/app/controllers/runtime-session-reset-view.js";
import { createComposerDrafts } from "../../web-ui/app/controllers/composer-drafts.js";
import { createRuntimeMaintenanceRequests } from "../../web-ui/app/services/runtime-web-client/runtime-maintenance.js";

const feature = vi.hoisted(() => ({ confirm: vi.fn(async () => true), refresh: vi.fn(async () => {}) }));
vi.mock("../../web-ui/app/components/confirmation-dialog.js", () => ({ confirmDialog: feature.confirm }));
vi.mock("../../web-ui/app/components/runtime-maintenance.js", () => ({ createRuntimeMaintenanceView: () => ({ render() {} }) }));
vi.mock("../../web-ui/app/services/workspace-state.js", () => ({ workspaceQueue: () => ({ refresh: feature.refresh }) }));
afterEach(() => { vi.clearAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const sessionResult = () => ({ complete: true, deletedSessionIds: ["one"], clearedSessionIds: ["spark"], failedSessionIds: [], deletedMessages: 3, deletedRequests: 1 });
function fixture() {
  let environment = "dev";
  const client = { supportsRuntimeMaintenance: () => true,
    resetRuntimeSessions: vi.fn(async () => ({ ok: true, result: sessionResult() })),
    clearRuntimeLogs: vi.fn(async () => ({ ok: true, result: { complete: true, clearedFiles: 2, removedRotatedFiles: 1 } })) };
  const confirmAction = vi.fn<(...args: any[]) => Promise<boolean>>(async () => true);
  const onSessionsReset = vi.fn(async (..._args: any[]) => {});
  const onLogsReset = vi.fn(async (..._args: any[]) => {});
  const controller = createRuntimeMaintenanceController({ client, confirmAction, onSessionsReset, onLogsReset, getEnvironmentId: () => environment });
  return { client, controller, confirmAction, onSessionsReset, onLogsReset,
    changeEnvironment(value: string) { environment = value; controller.environmentChanged(); } };
}

test("native clients send separate explicit confirmations in the selected environment", async () => {
  const requestApi = vi.fn(async () => ({ ok: true }));
  const client = createRuntimeMaintenanceRequests({ requestApi, environmentQuery: encodeURIComponent, getConfig: () => ({ backend: "runtime" }) });
  await client.resetRuntimeSessions("dev one"); await client.clearRuntimeLogs("prod");
  expect(requestApi.mock.calls).toEqual([
    ["/runtime/maintenance/sessions?environment=dev%20one", { method: "POST", body: '{"confirmed":true}' }],
    ["/runtime/maintenance/logs?environment=prod", { method: "POST", body: '{"confirmed":true}' }],
  ]);
});

test.each(["sessions", "logs"])("cancel %s never mutates", async (action) => {
  const f = fixture(); f.confirmAction.mockResolvedValue(false); await f.controller.reset(action);
  expect(f.client.resetRuntimeSessions).not.toHaveBeenCalled(); expect(f.client.clearRuntimeLogs).not.toHaveBeenCalled();
});

test("session confirmation names scope, uploaded files, SPARK and preserved independent data", async () => {
  const f = fixture(); await f.controller.reset("sessions");
  const warning = f.confirmAction.mock.calls[0]![0] as string;
  for (const text of ['"dev"', "every file uploaded", "SPARK chat history", "ARE INCLUDED", "Schedules", "Standalone automations", "long-term memory", "cannot be undone"])
    expect(warning).toContain(text);
  expect(f.client.clearRuntimeLogs).not.toHaveBeenCalled();
  expect(f.onSessionsReset).toHaveBeenCalledWith(sessionResult(), "dev");
});

test("logs confirmation and callback remain separate", async () => {
  const f = fixture(); await f.controller.reset("logs");
  const warning = f.confirmAction.mock.calls[0]![0] as string;
  expect(warning).toContain('"dev"'); expect(warning).toContain("Shared service logs");
  expect(f.client.resetRuntimeSessions).not.toHaveBeenCalled(); expect(f.onSessionsReset).not.toHaveBeenCalled();
  expect(f.onLogsReset).toHaveBeenCalledOnce();
});

test("changing environment away and back invalidates a pending confirmation", async () => {
  const f = fixture(); const pending = deferred<boolean>(); f.confirmAction.mockReturnValue(pending.promise);
  const resetting = f.controller.reset("sessions"); f.changeEnvironment("prod"); f.changeEnvironment("dev"); pending.resolve(true); await resetting;
  expect(f.client.resetRuntimeSessions).not.toHaveBeenCalled(); expect(f.controller.snapshot().pending).toBe(false);
});

test("both controls stay guarded while confirmation or mutation is pending", async () => {
  const f = fixture(); const pending = deferred<boolean>(); f.confirmAction.mockReturnValue(pending.promise);
  const resetting = f.controller.reset("sessions"); await f.controller.reset("logs"); await f.controller.reset("sessions");
  expect(f.confirmAction).toHaveBeenCalledOnce(); pending.resolve(true); await resetting;
  expect(f.client.resetRuntimeSessions).toHaveBeenCalledOnce(); expect(f.client.clearRuntimeLogs).not.toHaveBeenCalled();
});

test("partial deletion reports failures and reconciles only the acknowledged result", async () => {
  const f = fixture(); const result = { ...sessionResult(), complete: false, failedSessionIds: ["failed"] };
  f.client.resetRuntimeSessions.mockResolvedValue({ ok: true, result } as any); await f.controller.reset("sessions");
  expect(f.controller.snapshot()).toMatchObject({ failed: true });
  expect(f.controller.snapshot().message).toContain("1"); expect(f.onSessionsReset).toHaveBeenCalledWith(result, "dev");
});

test.each(["runtime_maintenance_busy", "runtime_maintenance_pending_approvals"])("owner refusal %s does not reconcile views", async (code) => {
  const f = fixture(); f.client.resetRuntimeSessions.mockRejectedValue(Object.assign(new Error(code), { code }));
  await f.controller.reset("sessions"); expect(f.controller.snapshot().failed).toBe(true); expect(f.onSessionsReset).not.toHaveBeenCalled();
});

test("late response still acknowledges captured scope without displaying success in another environment", async () => {
  const f = fixture(); const pending = deferred<any>(); f.client.resetRuntimeSessions.mockReturnValue(pending.promise);
  const resetting = f.controller.reset("sessions"); await vi.waitFor(() => expect(f.client.resetRuntimeSessions).toHaveBeenCalled());
  f.changeEnvironment("prod"); pending.resolve({ ok: true, result: sessionResult() }); await resetting;
  expect(f.onSessionsReset).toHaveBeenCalledWith(sessionResult(), "dev"); expect(f.controller.snapshot().message).toBe("");
});

test("feature refreshes persisted queues before both view owners even if one fails", async () => {
  const f = fixture(); const order: string[] = [];
  feature.refresh.mockImplementationOnce(async () => { order.push("queue"); });
  const ordinary = vi.fn(async () => { order.push("ordinary"); throw new Error("refresh failed"); });
  const companion = vi.fn(async () => { order.push("spark"); });
  const maintenance = createRuntimeMaintenanceFeature({ root: {}, client: f.client, getEnvironmentId: () => "dev", onSessionsReset: ordinary });
  maintenance.setCompanionResetHandler(companion); await maintenance.reset("sessions");
  expect(order).toEqual(["queue", "ordinary", "spark"]); expect(companion).toHaveBeenCalledWith(sessionResult(), "dev");
  expect(maintenance.snapshot().message).toContain("could not refresh");
});

function viewFixture() {
  const state = { currentSessionId: "one", sessions: [{ id: "one" }, { id: "failed" }], sessionModels: { one: "m", failed: "keep" }, sessionModes: { one: "ask", failed: "ask" }, lastModelByEnvironment: {} };
  const preferences = { sessionIdForEnvironment: () => "one", loadSessionSidebar: () => ({ archivedSessionIds: ["one", "failed"], orderedSessionIds: ["one", "failed"] }),
    saveSessionModes: vi.fn(), saveModelPreferences: vi.fn(), saveSessionSidebar: vi.fn(), saveSessionIdForEnvironment: vi.fn() };
  const input = { result: { ...sessionResult(), complete: false, failedSessionIds: ["failed"] }, environmentId: "dev", getEnvironmentId: () => "dev", state, preferences,
    preserveSessionDraft: vi.fn(), restoreSessionDraft: vi.fn(), clearSessionDraft: vi.fn(), refreshComposer: vi.fn(), clearCurrentSession: vi.fn(), loadSessions: vi.fn(), refreshDashboard: vi.fn(), forgetDeletedSessionPins: vi.fn() };
  return input;
}
test("view cleanup touches acknowledged targets, preserves failed sessions and clears deleted selection", async () => {
  const f = viewFixture(); await reconcileRuntimeSessionReset(f);
  expect(f.clearSessionDraft.mock.calls).toEqual([[{ environmentId: "dev", sessionId: "one" }, true], [{ environmentId: "dev", sessionId: "spark" }, false]]);
  expect(f.state.sessions).toEqual([{ id: "failed" }]); expect(f.state.sessionModels).toEqual({ failed: "keep" });
  expect(f.clearCurrentSession).toHaveBeenCalledOnce(); expect(f.forgetDeletedSessionPins).toHaveBeenCalledWith(["one"]);
  expect(f.preferences.saveSessionSidebar).toHaveBeenCalledWith("dev", { archivedSessionIds: ["failed"], orderedSessionIds: ["failed"] });
  expect(f.preferences.saveSessionIdForEnvironment).toHaveBeenCalledWith("dev", ""); expect(f.refreshComposer).toHaveBeenCalledOnce();
});
test("view cleanup invalidates captured drafts without refreshing another environment", async () => {
  const f = viewFixture(); f.getEnvironmentId = () => "prod"; await reconcileRuntimeSessionReset(f);
  expect(f.clearSessionDraft).toHaveBeenCalledWith({ environmentId: "dev", sessionId: "spark" }, false);
  expect(f.loadSessions).not.toHaveBeenCalled(); expect(f.refreshComposer).not.toHaveBeenCalled();
});
test("bulk draft reset invalidates late uploads and deleted queue ownership while preserving text", () => {
  const drafts = createComposerDrafts(); const scope = { environmentId: "dev", sessionId: "spark" }; const draft = drafts.open(scope);
  draft.text = "Unsent text"; draft.attachments = [{ id: "file" }]; draft.setRelease({ releaseToken: "deleted-queue", item: { waitForRequestId: "old", text: "Unsent text", attachments: [], agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: null } });
  const upload = draft.startUpload(); drafts.resetSessionData(scope);
  expect(draft.text).toBe("Unsent text"); expect(draft.attachments).toEqual([]); expect(draft.release).toBe(null);
  expect(draft.acceptUpload(upload, { id: "late" })).toBe(false);
});

test("explicit reset notices reconcile other tabs and deduplicate the matching HTTP acknowledgement", async () => {
  const f = fixture(); const reset = { ...sessionResult(), resetId: "first" };
  f.client.resetRuntimeSessions.mockResolvedValue({ ok: true, result: reset });
  const ordinary = vi.fn(async () => {}); const companion = vi.fn(async () => {});
  const maintenance = createRuntimeMaintenanceFeature({ root: {}, client: f.client, getEnvironmentId: () => "dev", onSessionsReset: ordinary });
  maintenance.setCompanionResetHandler(companion);
  await maintenance.observeRealtimeMessage({ type: "workspace_changed", environment: "dev", resources: ["sessions", "client-state"], sessionReset: reset });
  await maintenance.reset("sessions");
  await maintenance.observeRealtimeMessage({ type: "workspace_changed", environment: "dev", sessionReset: reset });
  expect(ordinary).toHaveBeenCalledOnce(); expect(companion).toHaveBeenCalledOnce();
  expect(feature.refresh).toHaveBeenCalledOnce();
  await maintenance.observeRealtimeMessage({ type: "workspace_changed", environment: "dev", sessionReset: { ...reset, resetId: "second" } });
  expect(companion).toHaveBeenCalledTimes(2);
});
test("ordinary workspace changes do not imply a destructive draft reset", async () => {
  const f = fixture(); const ordinary = vi.fn();
  const maintenance = createRuntimeMaintenanceFeature({ root: {}, client: f.client, getEnvironmentId: () => "dev", onSessionsReset: ordinary });
  await maintenance.observeRealtimeMessage({ type: "workspace_changed", environment: "dev", resources: ["sessions", "client-state"] });
  expect(ordinary).not.toHaveBeenCalled(); expect(feature.refresh).not.toHaveBeenCalled();
});
