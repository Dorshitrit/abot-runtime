import { describe, expect, it } from "vitest";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import { makeOwnerControlPeer as makePeer } from "./support/local-runtime-owner-peer.js";
import type { ToolApprovalRequest } from "../ports.js";
import type { SchedulerRun } from "../scheduler/contracts.js";

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
const approval: ToolApprovalRequest = {
  requestId: run.requestId,
  approvalId: "approval",
  call: { tool: "tool", params: {} },
};

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

  it.each(["finalizing", "cancelled"])(
    "projects exact request activity through %s until canonical finish",
    (phase) => {
      const controls = new LocalRequestControls(() => {});
      const { peer } = makePeer("origin");
      const options = controls.ordinary("ordinary", peer, {}, "session");
      expect(controls.listApprovals()).toEqual([]);
      expect(controls.hasActiveRequest("ordinary", "session")).toBe(true);
      expect(controls.hasActiveRequest("ordinary", "other")).toBe(false);
      expect(controls.hasActiveRequest("absent", "session")).toBe(false);
      expect(controls.hasActiveRequest(undefined, "session")).toBe(false);
      expect(controls.hasActiveRequest("ordinary", undefined)).toBe(false);
      if (phase === "finalizing") options.claimFinalization!();
      else controls.cancel("ordinary", "session");
      expect(controls.hasActiveRequest("ordinary", "session")).toBe(true);
      controls.finish("ordinary");
      expect(controls.hasActiveRequest("ordinary", "session")).toBe(false);
    },
  );

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

  it("retains scheduled approval with canonical run metadata after every control peer detaches", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    await controls.register(origin.peer);
    const options = controls.scheduled(run);
    origin.close();
    const pending =
      options.toolApprovalController!.requestToolApproval(approval);
    expect(controls.listApprovals(run.sessionId)).toEqual([
      {
        sessionId: run.sessionId,
        request: approval,
        run,
      },
    ]);
    expect(
      controls.decideApproval(
        {
          sessionId: run.sessionId,
          requestId: run.requestId,
          approvalId: approval.approvalId,
          approved: false,
        },
        makePeer("different-scheduled-observer").peer,
      ),
    ).toEqual({ accepted: true });
    await expect(pending).resolves.toEqual({ approved: false });
    controls.finish(run.requestId);
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
      { ...approval, requestId: "ordinary" },
      { abortSignal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
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
    const pending = options.toolApprovalController!.requestToolApproval({
      ...approval,
      requestId: "ordinary",
    });
    controls.stop();
    await expect(pending).rejects.toThrow("request_interrupted");
    expect(options.requestSteering!.isCurrent(0)).toBe(true);
    await options.requestSteering!.close();
  });
});
