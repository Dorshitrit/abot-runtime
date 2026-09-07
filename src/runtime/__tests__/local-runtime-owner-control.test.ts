import { describe, expect, it, vi } from "vitest";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import type { LocalRuntimePeer } from "../local-host/contracts.js";
import type { ToolApprovalRequest } from "../ports.js";
import type { SchedulerRun } from "../scheduler/contracts.js";

function makePeer(id: string) {
  const listeners = new Set<() => void>();
  let closed = false;
  const callClient = vi.fn<LocalRuntimePeer["callClient"]>(async () => ({
    approved: true,
  }));
  const peer: LocalRuntimePeer = {
    id,
    callClient,
    onClose(listener) {
      if (closed) listener();
      else listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    peer,
    callClient,
    close() {
      closed = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}

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
const approval = {
  requestId: run.requestId,
  approvalId: "approval",
  call: { tool: "tool", input: {} },
} as unknown as ToolApprovalRequest;

describe("local owner request controls", () => {
  it("preloads steering once and returns the owner's canonical duplicate/conflict result", () => {
    const controls = new LocalRequestControls(() => {});
    const { peer } = makePeer("ordinary");
    const input = {
      steerId: "initial",
      text: "Keep the earlier scope.",
      sequence: 1,
    };
    const options = controls.ordinary("ordinary", peer, {
      steeringUpdates: [input],
    });
    expect(options.requestSteering?.snapshot()).toEqual({
      version: 1,
      updates: [input],
    });
    expect(controls.steer("ordinary", input)).toMatchObject({
      ok: true,
      duplicate: true,
    });
    expect(
      controls.steer("ordinary", { ...input, text: "Different scope." }),
    ).toEqual({ ok: false, reason: "steer_id_conflict" });
    controls.finish("ordinary");
    expect(controls.steer("ordinary", input)).toEqual({
      ok: false,
      reason: "request_not_active",
    });
  });

  it("does not install an approval controller when none is available", () => {
    const controls = new LocalRequestControls(() => {});
    expect(
      controls.ordinary("ordinary", makePeer("bridge").peer, {})
        .toolApprovalController,
    ).toBeUndefined();
    expect(controls.scheduled(run).toolApprovalController).toBeUndefined();
    controls.stop();
  });

  it("does not leave an active request behind when initial steering input is malformed", () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    expect(() =>
      controls.ordinary("ordinary", origin.peer, {
        steeringUpdates: [
          { steerId: "invalid", text: undefined, sequence: 1 },
        ] as never,
      }),
    ).toThrow();
    expect(() => controls.ordinary("ordinary", origin.peer, {})).not.toThrow();
    controls.stop();
  });

  it("publishes started metadata before approval and replays active metadata on registration", async () => {
    const order: string[] = [];
    const controls = new LocalRequestControls(() => {
      order.push("started");
    });
    const first = makePeer("first");
    const second = makePeer("second");
    first.callClient.mockImplementation(async () => {
      order.push("approval");
      return { approved: true };
    });
    await controls.register(first.peer);
    const options = controls.scheduled(run);
    await controls.register(second.peer);
    expect(second.callClient).toHaveBeenCalledWith("scheduled.started", [run]);
    await expect(
      options.toolApprovalController!.requestToolApproval(approval),
    ).resolves.toEqual({ approved: true });
    expect(order).toEqual(["started", "approval"]);
    expect(second.callClient).not.toHaveBeenCalledWith(
      "request.approval",
      expect.anything(),
    );
    controls.finish(run.requestId);
    second.callClient.mockClear();
    await controls.register(second.peer);
    expect(second.callClient).not.toHaveBeenCalled();
  });

  it("rejects a lost peer's pending approval without replay to another peer", async () => {
    const controls = new LocalRequestControls(() => {});
    const first = makePeer("first");
    const second = makePeer("second");
    first.callClient.mockImplementation(() => new Promise(() => {}));
    controls.register(first.peer);
    controls.register(second.peer);
    const pending = controls
      .scheduled(run)
      .toolApprovalController!.requestToolApproval(approval);
    first.close();
    await expect(pending).resolves.toMatchObject({
      approved: false,
      reason: expect.stringContaining("closed"),
    });
    expect(second.callClient).not.toHaveBeenCalled();
    controls.finish(run.requestId);
    await expect(
      controls
        .scheduled({ ...run, requestId: "next" })
        .toolApprovalController!.requestToolApproval(approval),
    ).resolves.toEqual({ approved: true });
    expect(second.callClient).toHaveBeenCalledOnce();
    controls.stop();
  });

  it("resolves immediately if an already disconnected peer is selected", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    const options = controls.ordinary("ordinary", origin.peer, {
      approvalAvailable: true,
    });
    origin.close();
    await expect(
      options.toolApprovalController!.requestToolApproval(approval),
    ).resolves.toMatchObject({ approved: false });
    expect(origin.callClient).not.toHaveBeenCalled();
    controls.stop();
  });

  it("cancels remote approval when its canonical abort signal fires", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    origin.callClient.mockImplementation((method) =>
      method === "request.approval"
        ? new Promise(() => {})
        : Promise.resolve(undefined),
    );
    const controller = new AbortController();
    const options = controls.ordinary("ordinary", origin.peer, {
      approvalAvailable: true,
    });
    const pending = options.toolApprovalController!.requestToolApproval(
      approval,
      { abortSignal: controller.signal },
    );
    controller.abort();
    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(origin.callClient).toHaveBeenCalledWith("request.approval.cancel", [
      approval.approvalId,
    ]);
    controls.stop();
  });

  it("stops waiting for approval at owner shutdown without closing an active core inbox", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    origin.callClient.mockImplementation(() => new Promise(() => {}));
    const options = controls.ordinary("ordinary", origin.peer, {
      approvalAvailable: true,
    });
    const pending =
      options.toolApprovalController!.requestToolApproval(approval);
    controls.stop();
    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(options.requestSteering!.isCurrent(0)).toBe(true);
    await options.requestSteering!.close();
  });
});
