import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { RuntimeRequestOptions } from "../composition.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { ManagedWebToolApprovals } from "../../web-ui/local-runtime/managed-tool-approvals.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";

function fixture() {
  const event = {
    type: "event",
    name: "tool.approval.required",
    requestId: "request",
    approvalId: "approval",
    tool: "inspect_target",
    executionId: "execution",
    roleCallId: "call",
    executorRole: "worker",
    eventSequence: 7,
  };
  const pending: LocalPendingToolApproval = {
    sessionId: "session",
    request: {
      requestId: "request",
      approvalId: "approval",
      call: { tool: "inspect_target", params: {} },
    },
  };
  let accepted: (() => void) | undefined;
  let socket: WebSocket | undefined;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const hub = new RealtimeClientHub();
  const broadcast = vi.spyOn(hub, "broadcast");
  const requests = new LocalRequestExecution(hub);
  const environment = {
    approvals: {
      list: vi.fn(async () => [pending]),
      decide: vi.fn(async () => ({ accepted: true as const })),
      attach: vi.fn(
        (
          _requestId: string,
          _sessionId: string,
          ws: WebSocket,
          _options?: RuntimeRequestOptions,
          onAccepted?: () => void,
        ) => {
          socket = ws;
          accepted = onAccepted;
          return completion;
        },
      ),
    },
    requests: { handle: vi.fn() },
    services: {
      sessions: {
        getRequestReplayById: vi.fn(async () => ({
          requestId: "request",
          sessionId: "session",
          events: [event],
          finalState: null,
        })),
      },
    },
  };
  const access = new ManagedWebToolApprovals(
    () => environment as unknown as RuntimeEnvironment,
    requests,
  );
  const scope = {
    environmentId: "dev",
    sessionId: "session",
    requestId: "request",
    approvalId: "approval",
    approved: true,
  };
  return {
    access,
    environment,
    requests,
    event,
    scope,
    broadcast,
    accept: () => accepted?.(),
    fail,
    complete: () => {
      socket?.send(
        JSON.stringify({
          type: "completed",
          requestId: "request",
          output: "done",
        }),
      );
      finish();
    },
  };
}

describe("Web owner-backed pending approval restoration", () => {
  it("presents only live owner approvals and preserves original execution identity", async () => {
    const f = fixture();
    expect(await f.access.list("dev")).toEqual([
      {
        environmentId: "dev",
        sessionId: "session",
        requestId: "request",
        approvalId: "approval",
        event: f.event,
      },
    ]);
    expect(f.environment.approvals.attach).not.toHaveBeenCalled();
    expect(f.environment.requests.handle).not.toHaveBeenCalled();
    f.environment.approvals.list.mockResolvedValueOnce([]);
    expect(await f.access.list("dev")).toEqual([]);
  });

  it("waits for owner attachment before sending a late decision, then delivers the same request", async () => {
    const f = fixture();
    const decision = f.access.decide(f.scope);
    await vi.waitFor(() =>
      expect(f.environment.approvals.attach).toHaveBeenCalledOnce(),
    );
    expect(f.environment.approvals.decide).not.toHaveBeenCalled();
    expect(
      f.requests.activeReplayForSession("request", "session", "dev"),
    ).toContainEqual(f.event);
    f.accept();
    expect(await decision).toBe(true);
    expect(f.environment.approvals.decide).toHaveBeenCalledWith({
      sessionId: "session",
      requestId: "request",
      approvalId: "approval",
      approved: true,
      reason: undefined,
    });
    f.complete();
    await vi.waitFor(() => expect(f.requests.healthDetails()).toEqual([]));
    expect(f.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "completed",
        requestId: "request",
        sessionId: "session",
        environment: "dev",
      }),
    );
    expect(f.environment.requests.handle).not.toHaveBeenCalled();
  });

  it("restores a chat approval without making a decision", async () => {
    const f = fixture();
    const restored = f.access.resume("dev", "request");
    await vi.waitFor(() =>
      expect(f.environment.approvals.attach).toHaveBeenCalledOnce(),
    );
    f.accept();
    await restored;
    expect(f.environment.approvals.decide).not.toHaveBeenCalled();
    f.complete();
  });

  it.each([
    ["  This target is out of scope.  ", "This target is out of scope."],
    ["   ", undefined],
    [42, undefined],
  ])(
    "preserves a validated realtime rejection reason (%j)",
    async (reason, expected) => {
      const f = fixture();
      const decision = f.access.resolveRealtime(
        {
          type: "tool_approval_response",
          approvalId: "approval",
          approved: false,
          reason,
        },
        "dev",
      );
      await vi.waitFor(() =>
        expect(f.environment.approvals.attach).toHaveBeenCalledOnce(),
      );
      f.accept();
      await decision;
      expect(f.environment.approvals.decide).toHaveBeenCalledWith({
        sessionId: "session",
        requestId: "request",
        approvalId: "approval",
        approved: false,
        reason: expected,
      });
      f.complete();
    },
  );

  it("does not consume stale or mismatched approvals", async () => {
    const f = fixture();
    for (const field of ["sessionId", "requestId", "approvalId"]) {
      expect(await f.access.decide({ ...f.scope, [field]: "other" })).toBe(
        false,
      );
    }
    expect(f.environment.approvals.attach).not.toHaveBeenCalled();
    expect(f.environment.approvals.decide).not.toHaveBeenCalled();
  });

  it("keeps attachment failure separate from user rejection", async () => {
    const f = fixture();
    f.environment.approvals.attach.mockRejectedValueOnce(
      new Error("connection unavailable"),
    );
    await expect(f.access.decide(f.scope)).rejects.toThrow(
      "connection unavailable",
    );
    expect(f.environment.approvals.decide).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "failed" }),
    );
    expect(f.requests.healthDetails()).toEqual([]);
    expect(await f.access.list("dev")).toHaveLength(1);
  });

  it("removes a provisional view if another client already settled the approval", async () => {
    const f = fixture();
    f.environment.approvals.attach.mockRejectedValueOnce(
      new Error("local_runtime_request_not_awaiting_approval"),
    );
    await expect(f.access.decide(f.scope)).rejects.toThrow(
      "not_awaiting_approval",
    );
    expect(f.requests.healthDetails()).toEqual([]);
    expect(f.environment.approvals.decide).not.toHaveBeenCalled();
  });

  it("cleans up a lost attachment after readiness without inventing a terminal result", async () => {
    const f = fixture();
    const restored = f.access.resume("dev", "request");
    await vi.waitFor(() =>
      expect(f.environment.approvals.attach).toHaveBeenCalledOnce(),
    );
    f.accept();
    await restored;
    f.fail(new Error("local_runtime_connection_lost"));
    await vi.waitFor(() => expect(f.requests.healthDetails()).toEqual([]));
    expect(f.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "control",
        name: "local_runtime_approval_attachment_lost",
      }),
    );
    expect(f.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "failed" }),
    );
  });
});
