import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { SessionStore } from "../ports.js";
import type { RuntimeRequestApprovalControls } from "../request/approval-controls.js";
import { createBridgeApprovalAccess } from "../../bridge/request-approval-access.js";
import { BridgeApprovalDelivery } from "../../bridge/request-approval-delivery.js";
import {
  readApprovalDecision,
  refuseUnsupportedApprovalMessage,
} from "../../bridge/request-approval-protocol.js";

function socket() {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const scope = {
  correlationId: "query",
  sessionId: "session",
  requestId: "request",
};
const pending = {
  sessionId: scope.sessionId,
  request: {
    requestId: scope.requestId,
    approvalId: "approval",
    call: { tool: "tool", params: {} },
  },
  wait: { generation: "generation", waitId: "wait", revision: 4 },
};

function fixture() {
  let current = socket();
  let listener: (event: Record<string, unknown>) => void = () => {};
  const unsubscribe = vi.fn();
  const controls: RuntimeRequestApprovalControls = {
    list: vi.fn(async () => [pending]),
    decide: vi.fn(async () => ({ accepted: true as const })),
    attach: vi.fn(async (_requestId, _sessionId, _socket, _options, accepted) =>
      accepted?.(),
    ),
    subscribeEvents: (next) => {
      listener = next;
      return unsubscribe;
    },
  };
  const sessions = {
    getRequestReplayById: vi.fn(async (requestId: string) => ({
      sessionId: scope.sessionId,
      requestId,
      events: [],
      finalState: null,
    })),
  } as unknown as SessionStore;
  const access = createBridgeApprovalAccess({
    controls,
    sessions,
    currentSocket: () => current,
    legacyController: () => ({
      requestToolApproval: async () => ({ approved: false }),
    }),
  });
  return {
    access,
    controls,
    sessions,
    unsubscribe,
    get socket() {
      return current;
    },
    replace() {
      const previous = current;
      current = socket();
      access.disconnect(previous);
      return previous;
    },
    publish: (event: Record<string, unknown>) => listener(event),
    recover: (requestId = scope.requestId) =>
      access.handleMessage(current, {
        type: "request.approvals.request",
        ...scope,
        requestId,
      }),
  };
}

describe("Bridge owner approval access", () => {
  it("restores a consumed decision's running event view on a replacement connection", async () => {
    const f = fixture();
    await f.recover();
    f.replace();
    vi.mocked(f.controls.list).mockResolvedValue([]);
    vi.mocked(f.controls.decide).mockResolvedValue({
      accepted: true,
      duplicate: true,
    });
    const message = {
      type: "request.approval.decide.request",
      ...scope,
      approvalId: "approval",
      approved: true,
      ...pending.wait,
      commandId: "consumed",
    };
    await f.access.handleMessage(f.socket, message);
    expect(f.controls.decide).toHaveBeenCalledExactlyOnceWith({
      sessionId: scope.sessionId,
      requestId: scope.requestId,
      approvalId: "approval",
      approved: true,
      ...pending.wait,
      commandId: "consumed",
    });
    vi.mocked(f.socket.send).mockClear();
    f.publish({
      requestOrigin: "approval",
      ...scope,
      type: "event",
      name: "tool.completed",
    });
    f.publish({ requestOrigin: "approval", ...scope, type: "completed" });
    expect(f.socket.send).toHaveBeenCalledTimes(2);
    f.publish({ requestOrigin: "approval", ...scope, type: "event" });
    expect(f.socket.send).toHaveBeenCalledTimes(2);
    f.access.stop();
  });

  it.each(["rejected", "uncertain"])(
    "rolls back a new retry view when the decision is %s",
    async (outcome) => {
      const f = fixture();
      vi.mocked(f.controls.list).mockResolvedValue([]);
      if (outcome === "rejected")
        vi.mocked(f.controls.decide).mockResolvedValue({
          accepted: false,
          reason: "approval_conflict",
        });
      else
        vi.mocked(f.controls.decide).mockRejectedValue(
          new Error("lost decision response"),
        );
      await f.access.handleMessage(f.socket, {
        type: "request.approval.decide.request",
        ...scope,
        approvalId: "approval",
        approved: true,
        ...pending.wait,
        commandId: "retry",
      });
      vi.mocked(f.socket.send).mockClear();
      f.publish({ requestOrigin: "approval", ...scope, type: "event" });
      expect(f.socket.send).not.toHaveBeenCalled();
      f.access.stop();
    },
  );

  it.each(["request.approvals.request", "request.approval.decide.request"])(
    "reconnects owner approval access before ordinary reads for %s",
    async (type) => {
      const f = fixture();
      let connected = false;
      vi.mocked(f.controls.list).mockImplementation(async () => {
        connected = true;
        return [pending];
      });
      vi.mocked(f.sessions.getRequestReplayById).mockImplementation(
        async () => {
          if (!connected) throw new Error("local_runtime_connection_lost");
          return {
            requestId: scope.requestId,
            sessionId: scope.sessionId,
            events: [],
            finalState: null,
          };
        },
      );
      await f.access.handleMessage(f.socket, {
        type,
        ...scope,
        approvalId: "approval",
        approved: true,
        ...pending.wait,
        commandId: "decision",
      });
      expect(f.controls.list).toHaveBeenCalledOnce();
      expect(
        JSON.parse(String(vi.mocked(f.socket.send).mock.calls.at(-1)?.[0])),
      ).toMatchObject({ ok: true });
      expect(
        vi.mocked(f.controls.list).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(f.sessions.getRequestReplayById).mock.invocationCallOrder[0]!,
      );
      f.access.stop();
    },
  );

  it("removes only the failed new run's view while preserving an existing recovered view", async () => {
    const f = fixture();
    await expect(
      f.access.runRequest(f.socket, "session", "failed-new", async () => {
        throw new Error("request_not_admitted");
      }),
    ).rejects.toThrow("request_not_admitted");
    vi.mocked(f.socket.send).mockClear();
    f.publish({
      requestOrigin: "approval",
      type: "event",
      sessionId: "session",
      requestId: "failed-new",
    });
    expect(f.socket.send).not.toHaveBeenCalled();
    await f.recover();
    await expect(
      f.access.runRequest(
        f.socket,
        scope.sessionId,
        scope.requestId,
        async () => {
          throw new Error("session_busy");
        },
      ),
    ).rejects.toThrow("session_busy");
    vi.mocked(f.socket.send).mockClear();
    f.publish({
      requestOrigin: "approval",
      type: "event",
      sessionId: scope.sessionId,
      requestId: scope.requestId,
    });
    expect(f.socket.send).toHaveBeenCalledOnce();
    f.access.stop();
  });

  it("never dispatches a decision or rebinds events after its socket is replaced during owner access", async () => {
    const f = fixture();
    const read = deferred<(typeof pending)[]>();
    vi.mocked(f.controls.list).mockReturnValue(read.promise);
    const original = f.socket;
    const decision = f.access.handleMessage(original, {
      type: "request.approval.decide.request",
      ...scope,
      approvalId: "approval",
      approved: true,
      ...pending.wait,
      commandId: "decision",
    });
    await vi.waitFor(() => expect(f.controls.list).toHaveBeenCalledOnce());
    f.replace();
    read.resolve([pending]);
    await decision;
    expect(f.controls.decide).not.toHaveBeenCalled();
    f.publish({
      requestOrigin: "approval",
      requestId: scope.requestId,
      sessionId: scope.sessionId,
      type: "completed",
    });
    expect(f.socket.send).not.toHaveBeenCalled();
    expect(original.send).not.toHaveBeenCalled();
    f.access.stop();
  });

  it("rolls back a failed recovery and never forwards unrelated owner events", async () => {
    const f = fixture();
    vi.mocked(f.sessions.getRequestReplayById)
      .mockResolvedValueOnce({
        sessionId: scope.sessionId,
        requestId: scope.requestId,
        events: [],
        finalState: null,
      })
      .mockRejectedValueOnce(new Error("private owner failure"));
    await f.recover();
    expect(vi.mocked(f.socket.send).mock.calls[0]?.[0]).toContain(
      "approval_access_unavailable",
    );
    expect(vi.mocked(f.socket.send).mock.calls[0]?.[0]).not.toContain(
      "private owner failure",
    );
    vi.mocked(f.socket.send).mockClear();
    const event = {
      requestOrigin: "approval",
      requestId: scope.requestId,
      sessionId: scope.sessionId,
      type: "event",
    };
    f.publish(event);
    expect(f.socket.send).not.toHaveBeenCalled();
    await f.recover();
    vi.mocked(f.socket.send).mockClear();
    f.publish({ ...event, sessionId: "other" });
    f.publish({ ...event, requestId: "other" });
    expect(f.socket.send).not.toHaveBeenCalled();
    f.publish(event);
    expect(f.socket.send).toHaveBeenCalledOnce();
    f.access.stop();
    f.publish(event);
    expect(f.socket.send).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("a recovery completing after disconnect cannot restore its routing binding", async () => {
    const f = fixture();
    const read = deferred<(typeof pending)[]>();
    vi.mocked(f.controls.list).mockReturnValueOnce(read.promise);
    const recovering = f.recover();
    await vi.waitFor(() => expect(f.controls.list).toHaveBeenCalledOnce());
    f.replace();
    read.resolve([pending]);
    await recovering;
    f.publish({ requestOrigin: "approval", ...scope, type: "event" });
    expect(f.socket.send).not.toHaveBeenCalled();
    f.access.stop();
  });
});

describe("Bridge approval delivery bounds", () => {
  it("refuses the 513th binding without evicting a pending view and recovers capacity on terminal events", () => {
    const ws = socket();
    const delivery = new BridgeApprovalDelivery(() => ws);
    for (let index = 0; index < 512; index += 1)
      delivery.bind(ws, "session", `request-${index}`);
    expect(() => delivery.bind(ws, "session", "overflow")).toThrow(
      "approval_delivery_capacity",
    );
    delivery.publish({
      type: "event",
      sessionId: "session",
      requestId: "request-0",
    });
    expect(ws.send).toHaveBeenCalledOnce();
    delivery.publish({
      type: "completed",
      sessionId: "session",
      requestId: "request-0",
    });
    expect(() => delivery.bind(ws, "session", "replacement")).not.toThrow();
    delivery.stop();
  });

  it("a stopped or disconnected binding does not redirect old request output to a replacement socket", () => {
    let current = socket();
    const delivery = new BridgeApprovalDelivery(() => current);
    delivery.bind(current, "session", "request");
    const source = delivery.requestSocket("session", "request");
    const event = JSON.stringify({ type: "event", requestId: "request" });
    const previous = current;
    current = socket();
    delivery.disconnect(previous);
    source.send(event);
    expect(current.send).not.toHaveBeenCalled();
    delivery.bind(current, "session", "request");
    source.send(event);
    expect(current.send).toHaveBeenCalledOnce();
    delivery.stop();
    source.send(event);
    expect(current.send).toHaveBeenCalledOnce();
  });
});

describe("Bridge approval protocol", () => {
  it("rejects partial or ill-typed durable identity instead of rebasing to a current wait", () => {
    const base = { ...scope, approvalId: "approval", approved: true };
    expect(
      readApprovalDecision({ ...base, waitId: "wait" }, scope),
    ).toBeUndefined();
    expect(
      readApprovalDecision(
        { ...base, ...pending.wait, revision: "4", commandId: "decision" },
        scope,
      ),
    ).toBeUndefined();
    expect(
      readApprovalDecision({ ...base, approved: "true" }, scope),
    ).toBeUndefined();
    expect(
      readApprovalDecision(
        { ...base, ...pending.wait, commandId: "decision" },
        scope,
      ),
    ).toMatchObject({ ...pending.wait, commandId: "decision" });
  });

  it("rejects unknown mode and unbound durable execution while leaving old runs alone", () => {
    const ws = socket();
    expect(
      refuseUnsupportedApprovalMessage(
        ws,
        { type: "run_request", ...scope },
        false,
      ),
    ).toBe(false);
    expect(
      refuseUnsupportedApprovalMessage(
        ws,
        { type: "run_request", ...scope, approvalMode: "future" },
        true,
      ),
    ).toBe(true);
    expect(vi.mocked(ws.send).mock.calls.at(-1)?.[0]).toContain(
      "approval_mode_unsupported",
    );
    expect(
      refuseUnsupportedApprovalMessage(
        ws,
        { type: "run_request", ...scope, approvalMode: "durable_v1" },
        false,
      ),
    ).toBe(true);
    expect(vi.mocked(ws.send).mock.calls.at(-1)?.[0]).toContain(
      "durable_approvals_unavailable",
    );
  });
});
