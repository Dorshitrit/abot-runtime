import { expect, it, vi } from "vitest";
import { createLocalRuntimeApplication } from "../local-application.js";
import type {
  LocalRuntimeCallHandler,
  LocalRuntimeConnection,
} from "../local-host/contracts.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { LocalRuntimeClientRequests } from "../local-host/client-requests.js";

vi.mock("../local-host/transport.js", () => ({
  createLocalRuntimeConnection: vi.fn(),
}));

it("restores scheduled controls and run snapshots exactly once on explicit approval reconnection", async () => {
  const fixture = await createSchedulerRuntimeFixture();
  await fixture.application.stop();
  let handler: LocalRuntimeCallHandler = async () => {};
  const closeObservers = new Set<() => void>();
  const reconnect = vi.fn(async () => false);
  let registration = 0;
  const run: SchedulerRun = {
    id: "run",
    jobId: "job",
    environmentId: "environment",
    sessionId: "session",
    requestId: "scheduled-request",
    title: "Scheduled",
    prompt: "Saved intent",
    modelProfileId: "model",
    agentMode: "reasoning",
    timeZone: "UTC",
    jobRevision: 1,
    scheduledAt: "2026-09-05T00:00:00Z",
    trigger: "manual",
    status: "running",
  };
  const call = vi.fn<LocalRuntimeConnection["call"]>(async (method) => {
    if (method === "controls.register") {
      registration += 1;
      await handler("scheduled.started", [
        { ...run, requestId: `scheduled-${registration}` },
      ]);
    }
    return [];
  });
  vi.mocked(createLocalRuntimeConnection).mockResolvedValue({
    ownership: "client",
    call,
    reconnect,
    subscribe: () => () => {},
    setClientHandler: (next) => {
      handler = next;
    },
    onClose: (listener) => {
      closeObservers.add(listener);
      return () => {
        closeObservers.delete(listener);
      };
    },
    close: async () => {},
    isOwnerIdle: () => false,
    closeIfIdle: async () => false,
  });
  const scheduledOptions = vi.fn(() => ({}));
  const application = createLocalRuntimeApplication(fixture.config, {
    scheduledRequestOptions: scheduledOptions,
  });
  try {
    await application.start();
    expect(scheduledOptions).toHaveBeenCalledTimes(1);
    for (const listener of closeObservers) listener();
    reconnect.mockResolvedValueOnce(true);
    await Promise.all([
      application.approvals.list(),
      application.approvals.list(),
    ]);
    expect(scheduledOptions).toHaveBeenCalledTimes(2);
    expect(scheduledOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: "scheduled-2" }),
    );
    expect(
      call.mock.calls.filter(([method]) => method === "controls.register"),
    ).toHaveLength(2);
    await application.approvals.list();
    expect(
      call.mock.calls.filter(([method]) => method === "controls.register"),
    ).toHaveLength(2);
    expect(createLocalRuntimeConnection).toHaveBeenCalledTimes(1);
  } finally {
    await application.stop();
    await fixture.dispose();
  }
});

it.each(["decide", "cancel"] as const)(
  "restores scheduled delivery for direct %s after loss without using ordinary request attachment",
  async (action) => {
    const call = vi.fn(async () => ({ accepted: true }));
    const reconnectCall = vi.fn(async () => []);
    const client = new LocalRuntimeClientRequests(
      call,
      () => ({}),
      reconnectCall,
    );
    const run: SchedulerRun = {
      id: "run",
      jobId: "job",
      environmentId: "environment",
      sessionId: "session",
      requestId: "scheduled-request",
      title: "Scheduled",
      prompt: "Saved intent",
      modelProfileId: "model",
      agentMode: "reasoning",
      timeZone: "UTC",
      jobRevision: 1,
      scheduledAt: "2026-09-05T00:00:00Z",
      trigger: "manual",
      status: "running",
    };
    client.receive({ type: "scheduled.started", run });
    client.receive({
      type: "scheduled.event",
      event: {
        requestId: run.requestId,
        name: "tool.approval.required",
        approvalId: "approval",
      },
    });
    client.close(true);
    const result =
      action === "decide"
        ? await client.approvals.decide({
            sessionId: run.sessionId,
            requestId: run.requestId,
            approvalId: "approval",
            approved: true,
          })
        : await client.requests.cancel!(run.requestId, run.sessionId);
    expect(result).toEqual({ accepted: true });
    expect(reconnectCall).toHaveBeenCalledExactlyOnceWith("request.approvals", [
      run.sessionId,
    ]);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      action === "decide" ? "request.approval.decide" : "request.cancel",
      expect.any(Array),
    );
    client.close();
  },
);
