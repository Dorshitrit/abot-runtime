import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../ports.js";
import { makeOwnerControlPeer as makePeer } from "./support/local-runtime-owner-peer.js";

const approval: ToolApprovalRequest = {
  requestId: "request",
  approvalId: "approval",
  call: { tool: "tool", params: { command: "exact action" } },
};
const identity = {
  sessionId: "session",
  requestId: "request",
  approvalId: "approval",
};

function pendingRequest() {
  const controls = new LocalRequestControls(() => {});
  const origin = makePeer("origin");
  let callback!: (decision: ToolApprovalDecision) => void;
  origin.callClient.mockImplementation((method) =>
    method === "request.approval"
      ? new Promise((resolve) => {
          callback = resolve;
        })
      : Promise.resolve(undefined),
  );
  const options = controls.ordinary(
    "request",
    origin.peer,
    { approvalAvailable: true },
    "session",
  );
  const settled = vi.fn();
  const pending = options
    .toolApprovalController!.requestToolApproval(approval)
    .then((decision) => {
      settled(decision);
      return decision;
    });
  return {
    controls,
    origin,
    options,
    pending,
    settled,
    callback: (decision: ToolApprovalDecision) => callback(decision),
  };
}

afterEach(() => vi.useRealTimers());

describe("owner-held pending tool approvals", () => {
  it("keeps the same approval pending across elapsed time and peer loss until an exact late decision", async () => {
    vi.useFakeTimers();
    const f = pendingRequest();
    f.origin.close();
    f.callback({ approved: false, reason: "stale closed client" });
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
    expect(f.settled).not.toHaveBeenCalled();
    expect(f.options.abortSignal!.aborted).toBe(false);
    expect(f.controls.listApprovals("session")).toEqual([
      { sessionId: "session", request: approval },
    ]);
    expect(
      f.controls.decideApproval({ ...identity, approved: true }, f.origin.peer),
    ).toEqual({
      accepted: true,
    });
    await expect(f.pending).resolves.toEqual({ approved: true });
    expect(f.controls.listApprovals()).toEqual([]);
    expect(
      f.controls.decideApproval(
        { ...identity, approved: false },
        f.origin.peer,
      ),
    ).toEqual({ accepted: false, reason: "approval_not_pending" });
    f.controls.finish("request");
  });

  it("does not translate a callback RPC failure into a user decision", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    origin.callClient.mockRejectedValue(new Error("connection lost"));
    const options = controls.ordinary(
      "request",
      origin.peer,
      { approvalAvailable: true },
      "session",
    );
    const settled = vi.fn();
    const pending = options
      .toolApprovalController!.requestToolApproval(approval)
      .then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(controls.listApprovals()).toHaveLength(1);
    controls.decideApproval(
      {
        ...identity,
        approved: false,
        reason: "User declined later",
      },
      origin.peer,
    );
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      approved: false,
      reason: "User declined later",
    });
    controls.finish("request");
  });

  it("binds decisions to the exact owner identity and keeps snapshots isolated", async () => {
    const f = pendingRequest();
    const snapshot = f.controls.listApprovals()[0]!;
    snapshot.request.approvalId = "changed";
    snapshot.request.call.tool = "changed";
    expect(f.controls.listApprovals()[0]!.request).toEqual(approval);
    for (const changed of [
      { sessionId: "other" },
      { requestId: "other" },
      { approvalId: "other" },
      { approved: "true" },
    ]) {
      expect(
        f.controls.decideApproval(
          { ...identity, approved: true, ...changed },
          f.origin.peer,
        ).accepted,
      ).toBe(false);
      expect(f.controls.listApprovals()).toHaveLength(1);
    }
    expect(f.controls.listApprovals("other")).toEqual([]);
    f.controls.decideApproval({ ...identity, approved: false }, f.origin.peer);
    await expect(f.pending).resolves.toEqual({ approved: false });
    expect(f.origin.callClient).toHaveBeenCalledWith(
      "request.approval.cancel",
      ["approval"],
    );
    f.controls.finish("request");
  });

  it("retains the initially bound identity if the request input is later mutated", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    origin.callClient.mockImplementation(() => new Promise(() => {}));
    const options = controls.ordinary(
      "request",
      origin.peer,
      { approvalAvailable: true },
      "session",
    );
    const input = structuredClone(approval);
    const pending = options.toolApprovalController!.requestToolApproval(input);
    input.requestId = "replacement-request";
    input.approvalId = "replacement-approval";
    expect(controls.listApprovals()[0]!.request).toEqual(approval);
    expect(
      controls.decideApproval({ ...identity, approved: true }, origin.peer),
    ).toEqual({
      accepted: true,
    });
    await expect(pending).resolves.toEqual({ approved: true });
    expect(controls.listApprovals()).toEqual([]);
    controls.finish("request");
  });

  it("reattaches event delivery to the same live request and rejects old callback decisions", async () => {
    const f = pendingRequest();
    const replacement = makePeer("replacement");
    let decide!: (decision: ToolApprovalDecision) => void;
    replacement.callClient.mockImplementation((method) =>
      method === "request.approval"
        ? new Promise((resolve) => {
            decide = resolve;
          })
        : Promise.resolve(undefined),
    );
    const attachedSettled = vi.fn();
    const attached = f.controls
      .attach("request", "session", replacement.peer)
      .then(attachedSettled);
    await Promise.resolve();
    expect(replacement.callClient.mock.calls.map(([method]) => method)).toEqual(
      ["request.accepted", "request.approval"],
    );
    f.callback({ approved: false });
    await Promise.resolve();
    expect(f.settled).not.toHaveBeenCalled();
    decide({ approved: true });
    await expect(f.pending).resolves.toEqual({ approved: true });
    f.controls.send("request", { type: "completed", requestId: "request" });
    await f.controls.drain("request");
    expect(replacement.callClient).toHaveBeenCalledWith("request.event", [
      "request",
      { type: "completed", requestId: "request" },
    ]);
    expect(f.origin.callClient).not.toHaveBeenCalledWith(
      "request.event",
      expect.anything(),
    );
    expect(attachedSettled).not.toHaveBeenCalled();
    f.controls.finish("request");
    await attached;
    expect(attachedSettled).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "revokes an old approved=%s callback before replacement readiness",
    async (approved) => {
      const f = pendingRequest();
      const replacement = makePeer("replacement");
      let accept!: () => void;
      replacement.callClient.mockImplementation((method) => {
        if (method === "request.accepted")
          return new Promise<void>((resolve) => {
            accept = resolve;
          });
        if (method === "request.approval") return new Promise(() => {});
        return Promise.resolve(undefined);
      });
      const executeTool = vi.fn();
      const continuation = f.pending.then((decision) => {
        if (decision.approved) executeTool();
      });
      const attached = f.controls.attach(
        "request",
        "session",
        replacement.peer,
      );
      f.callback({ approved });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.settled).not.toHaveBeenCalled();
      expect(executeTool).not.toHaveBeenCalled();
      expect(f.controls.listApprovals("session")).toEqual([
        { sessionId: "session", request: approval },
      ]);
      expect(replacement.callClient).not.toHaveBeenCalledWith(
        "request.approval",
        expect.anything(),
      );
      accept();
      await Promise.resolve();
      expect(
        f.controls.decideApproval(
          { ...identity, approved: true },
          replacement.peer,
        ),
      ).toEqual({ accepted: true });
      await continuation;
      expect(f.settled).toHaveBeenCalledExactlyOnceWith({ approved: true });
      expect(executeTool).toHaveBeenCalledOnce();
      f.controls.finish("request");
      await attached;
    },
  );

  it("requires the deciding ordinary peer to own the attached event delivery", async () => {
    const f = pendingRequest();
    const replacement = makePeer("replacement");
    replacement.callClient.mockImplementation((method) =>
      method === "request.approval"
        ? new Promise(() => {})
        : Promise.resolve(undefined),
    );
    expect(
      f.controls.decideApproval(
        { ...identity, approved: true },
        replacement.peer,
      ),
    ).toEqual({
      accepted: false,
      reason: "approval_request_not_attached",
    });
    expect(f.controls.listApprovals()).toHaveLength(1);
    const attached = f.controls.attach("request", "session", replacement.peer);
    await Promise.resolve();
    expect(
      f.controls.decideApproval(
        { ...identity, approved: false },
        f.origin.peer,
      ),
    ).toEqual({
      accepted: false,
      reason: "approval_request_not_attached",
    });
    expect(f.controls.listApprovals()).toHaveLength(1);
    expect(
      f.controls.decideApproval(
        { ...identity, approved: true },
        replacement.peer,
      ),
    ).toEqual({ accepted: true });
    await expect(f.pending).resolves.toEqual({ approved: true });
    f.controls.finish("request");
    await attached;
  });

  it("binds event delivery before the acceptance callback submits an immediate decision", async () => {
    const f = pendingRequest();
    const replacement = makePeer("replacement");
    replacement.callClient.mockImplementation(async (method) => {
      if (method !== "request.accepted") return undefined;
      expect(
        f.controls.decideApproval(
          { ...identity, approved: true },
          replacement.peer,
        ),
      ).toEqual({ accepted: true });
      await f.pending;
      f.controls.send("request", { type: "completed" });
      await f.controls.drain("request");
      f.controls.finish("request");
      return undefined;
    });
    await f.controls.attach("request", "session", replacement.peer);
    expect(replacement.callClient).toHaveBeenCalledWith("request.event", [
      "request",
      { type: "completed" },
    ]);
    expect(replacement.callClient).not.toHaveBeenCalledWith(
      "request.approval",
      expect.anything(),
    );
  });

  it("permits attachment only to the matching session while approval is pending", async () => {
    const f = pendingRequest();
    const replacement = makePeer("replacement");
    await expect(
      f.controls.attach("request", "wrong-session", replacement.peer),
    ).rejects.toThrow("session_mismatch");
    await expect(
      f.controls.attach("other", "session", replacement.peer),
    ).rejects.toThrow("not_awaiting_approval");
    expect(replacement.callClient).not.toHaveBeenCalled();
    f.controls.decideApproval({ ...identity, approved: true }, f.origin.peer);
    await f.pending;
    await expect(
      f.controls.attach("request", "session", replacement.peer),
    ).rejects.toThrow("not_awaiting_approval");
    f.controls.finish("request");
  });

  it("keeps an approval pending when its initial peer was already closed", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    const options = controls.ordinary(
      "request",
      origin.peer,
      { approvalAvailable: true },
      "session",
    );
    origin.close();
    const pending =
      options.toolApprovalController!.requestToolApproval(approval);
    expect(origin.callClient).not.toHaveBeenCalled();
    expect(controls.listApprovals()).toHaveLength(1);
    controls.decideApproval({ ...identity, approved: false }, origin.peer);
    await expect(pending).resolves.toEqual({ approved: false });
    controls.finish("request");
  });

  it("cancels an approval first requested after owner shutdown without stranding retirement", async () => {
    const controls = new LocalRequestControls(() => {});
    const origin = makePeer("origin");
    const options = controls.ordinary(
      "request",
      origin.peer,
      { approvalAvailable: true },
      "session",
    );
    controls.stop();
    expect(options.abortSignal!.aborted).toBe(true);
    await expect(
      options.toolApprovalController!.requestToolApproval(approval),
    ).rejects.toThrow("request_interrupted");
    expect(options.abortSignal!.aborted).toBe(true);
    expect(controls.listApprovals()).toEqual([]);
    expect(origin.callClient).not.toHaveBeenCalled();
    controls.finish("request");
  });

  it.each(["cancel", "shutdown"])(
    "honors explicit %s and ignores late approval",
    async (action) => {
      const f = pendingRequest();
      if (action === "cancel")
        expect(f.controls.cancel("request", "session")).toEqual({
          accepted: true,
        });
      else f.controls.stop();
      expect(f.options.abortSignal!.aborted).toBe(true);
      await expect(f.pending).rejects.toThrow(
        action === "cancel" ? "request_cancelled" : "request_interrupted",
      );
      expect(
        f.controls.decideApproval(
          { ...identity, approved: true },
          f.origin.peer,
        ).accepted,
      ).toBe(false);
      f.callback({ approved: true });
      await Promise.resolve();
      expect(f.settled).not.toHaveBeenCalled();
      f.controls.finish("request");
    },
  );
});
