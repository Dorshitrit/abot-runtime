import { expect, test, vi } from "vitest";
// @ts-expect-error Browser controller.
import { createSparkHomeRunController } from "../../web-ui/app/controllers/spark-home-run-controller.js";
import { createSparkHomeRequests } from "../../web-ui/app/services/runtime-web-client/spark-home.js";

const run = (changes = {}) => ({ runId: "home-1", revision: 1, status: "running", phase: "plan",
  startedAt: "now", updatedAt: "now", screenRevision: null, pendingApproval: null, errorCode: null, ...changes });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let environment = "dev";
  const client = {
    getSparkHomeRun: vi.fn(async (): Promise<{ run: any }> => ({ run: null })),
    startSparkHomeRun: vi.fn(async () => ({ run: run() })),
    cancelSparkHomeRun: vi.fn(async () => ({ run: run({ revision: 3, status: "cancelled" }) })),
    decideSparkHomeApproval: vi.fn(async () => ({ run: run({ revision: 3, phase: "collect" }) })),
  };
  const onPublished = vi.fn();
  const controller = createSparkHomeRunController({ client, getEnvironmentId: () => environment, isAvailable: () => true,
    render: vi.fn(), onPublished, setTimer: vi.fn(), clearTimer: vi.fn() });
  return { client, controller, onPublished, environment: (value: string) => { environment = value; return controller.environmentChanged(); } };
}

test("an owner with no previous HOME run is connected and idle", async () => {
  const h = fixture(); await h.controller.refresh();
  expect(h.controller.snapshot()).toMatchObject({ run: null, connected: true, error: "" });
  expect(h.client.startSparkHomeRun).not.toHaveBeenCalled();
});

test("generation uses saved HOME settings without submitting a prompt or touching an ordinary composer", async () => {
  const h = fixture(); h.client.getSparkHomeRun.mockResolvedValue({ run: run() });
  expect(await h.controller.start(7)).toBe(true);
  expect(h.client.startSparkHomeRun).toHaveBeenCalledExactlyOnceWith({ expectedSettingsRevision: 7 }, "dev");
  expect(h.controller.snapshot().run.runId).toBe("home-1");
  expect(await h.controller.start(7)).toBe(false);
  expect(h.client.startSparkHomeRun).toHaveBeenCalledOnce();
});

test("current HOME approval dispatches only its exact run and approval identity", async () => {
  const h = fixture();
  h.client.getSparkHomeRun.mockResolvedValue({ run: run({ revision: 2, status: "awaiting_approval",
    pendingApproval: { approvalId: "approve-1", tool: "web_search", summary: "Read a source" } }) });
  await h.controller.refresh();
  expect(await h.controller.decide("old", true)).toBe(false);
  expect(h.client.decideSparkHomeApproval).not.toHaveBeenCalled();
  h.client.getSparkHomeRun.mockResolvedValue({ run: run({ revision: 3, phase: "collect" }) });
  expect(await h.controller.decide("approve-1", false, "Skip this source")).toBe(true);
  expect(h.client.decideSparkHomeApproval).toHaveBeenCalledExactlyOnceWith({ runId: "home-1", approvalId: "approve-1", approved: false, reason: "Skip this source" }, "dev");
});

test("published revision refreshes the screen once, while cancelled runs never claim publication", async () => {
  const h = fixture();
  h.client.getSparkHomeRun.mockResolvedValue({ run: run({ revision: 4, status: "completed", screenRevision: 8 }) });
  await h.controller.refresh(); await h.controller.refresh();
  expect(h.onPublished).toHaveBeenCalledOnce();
  h.client.getSparkHomeRun.mockResolvedValue({ run: run({ runId: "home-2", status: "cancelled", screenRevision: null }) });
  await h.controller.refresh(); expect(h.onPublished).toHaveBeenCalledOnce();
});

test("older reads cannot replace newer approval state or cross an environment boundary", async () => {
  const h = fixture();
  h.client.getSparkHomeRun.mockResolvedValue({ run: run({ revision: 5, status: "awaiting_approval", pendingApproval: { approvalId: "a" } }) });
  await h.controller.refresh();
  h.client.getSparkHomeRun.mockResolvedValueOnce({ run: run({ revision: 3 }) });
  await h.controller.refresh(); expect(h.controller.snapshot().run.revision).toBe(5);
  const delayed = deferred<{ run: any }>(); h.client.getSparkHomeRun.mockReturnValueOnce(delayed.promise);
  const old = h.controller.refresh(); await Promise.resolve();
  h.client.getSparkHomeRun.mockResolvedValue({ run: null }); await h.environment("prod");
  delayed.resolve({ run: run({ revision: 9, status: "completed", screenRevision: 10 }) }); await old;
  expect(h.controller.snapshot()).toMatchObject({ environmentId: "prod", run: null });
  expect(h.onPublished).not.toHaveBeenCalled();
});

test("read failures remain uncertain and never start or replay a run", async () => {
  const h = fixture();
  h.client.getSparkHomeRun.mockRejectedValue(new Error("connection lost"));
  await h.controller.refresh();
  expect(h.controller.snapshot()).toMatchObject({ connected: false, run: null });
  expect(h.client.startSparkHomeRun).not.toHaveBeenCalled();
  expect(h.client.cancelSparkHomeRun).not.toHaveBeenCalled();
});

test("an unconfirmed start remains visible after an empty status read and is never automatically retried", async () => {
  const h = fixture(); h.client.startSparkHomeRun.mockRejectedValueOnce(new Error("network lost"));
  expect(await h.controller.start(7)).toBe(false);
  await h.controller.refresh();
  expect(h.controller.snapshot().error).toContain("could not be confirmed");
  expect(h.client.startSparkHomeRun).toHaveBeenCalledOnce();
});

test("HOME client confines run, approval, preference and calibration calls to its own endpoint", async () => {
  const requestApi = vi.fn(async (_path: string, _options?: RequestInit) => ({ ok: true }));
  const client = createSparkHomeRequests({ requestApi, resolveApiPath: value => value,
    getEnvironmentId: () => "dev", getConfig: () => ({ backend: "runtime" }) });
  await client.startSparkHomeRun({ expectedSettingsRevision: 2 });
  await client.decideSparkHomeApproval({ runId: "r", approvalId: "a", approved: true });
  await client.configureSparkHomePreferences({ expectedRevision: 1, mode: "spark_home" });
  await client.getSparkHomeRun({ runId: "r" });
  expect(requestApi.mock.calls.map(call => call[0])).toEqual([
    "/runtime/spark-home/runs?environment=dev", "/runtime/spark-home/runs/approval?environment=dev",
    "/runtime/spark-home/preferences?environment=dev", "/runtime/spark-home/runs?environment=dev&runId=r",
  ]);
  expect(JSON.stringify(requestApi.mock.calls)).not.toContain("/chat/");
});
