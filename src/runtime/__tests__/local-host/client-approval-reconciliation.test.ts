import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { LocalRuntimeClientRequests } from "../../local-host/client-requests.js";
import type { LocalPendingToolApproval } from "../../local-host/request-approval-contracts.js";
import type { SchedulerRun } from "../../scheduler/contracts.js";

const pending: LocalPendingToolApproval = {
  sessionId: "session",
  request: {
    requestId: "request",
    approvalId: "approval",
    call: { tool: "test.write", params: {} },
  },
};

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const run = gate<unknown>();
  const attachment = gate<unknown>();
  const read = gate<LocalPendingToolApproval[]>();
  const active = vi.fn(async () => false);
  const call = vi.fn(async (method: string) => {
    if (method === "request.cancel") return { accepted: true };
    if (method === "request.active") return active();
    return run.promise;
  });
  const approvalCall = vi.fn(async (method: string) => {
    if (method === "request.approvals") return read.promise;
    return attachment.promise;
  });
  const client = new LocalRuntimeClientRequests(call, undefined, approvalCall);
  const socket = { send: vi.fn() } as unknown as WebSocket;
  const options = {
    toolApprovalController: {
      requestToolApproval: () => new Promise<never>(() => {}),
    },
  };
  const settled = vi.fn();
  const handled = client.requests
    .handle(
      socket,
      {
        type: "run_request",
        requestId: "request",
        sessionId: "session",
        text: "Write the artifact",
      },
      options,
    )
    .then(
      () => settled("completed"),
      (error) => settled(error),
    );
  const disconnected = async () => {
    client.close(true);
    run.reject(new Error("local_runtime_connection_lost"));
    await new Promise<void>((resolve) =>
      queueMicrotask(() => queueMicrotask(resolve)),
    );
  };
  return {
    client,
    call,
    approvalCall,
    run,
    attachment,
    read,
    active,
    socket,
    options,
    settled,
    handled,
    disconnected,
  };
}

describe("owner reconciliation after an approval notification is lost", () => {
  it("publishes one terminal projection when an unconfirmed scheduled run finished while disconnected", async () => {
    const call = vi.fn(async () => false);
    const approvalCall = vi.fn(async () => []);
    const client = new LocalRuntimeClientRequests(
      call,
      () => ({
        toolApprovalController: {
          requestToolApproval: () => new Promise<never>(() => {}),
        },
      }),
      approvalCall,
    );
    const publish = vi.fn();
    client.subscribe(publish);
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
    client.close(true);
    expect(publish).not.toHaveBeenCalled();
    await client.approvals.list("session");
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      type: "failed",
      requestId: run.requestId,
      sessionId: run.sessionId,
      environment: run.environmentId,
      error: "local_runtime_disconnected_outcome_unknown",
    });
    await client.approvals.list("session");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledExactlyOnceWith("request.active", [
      run.requestId,
      run.sessionId,
    ]);
    client.close();
  });

  it("retains the handle before any approval event or callback and confirms it from the owner snapshot", async () => {
    const value = fixture();
    await value.client.handleCallback("request.accepted", ["request"]);
    await value.disconnected();
    expect(value.settled).not.toHaveBeenCalled();
    expect(value.approvalCall).not.toHaveBeenCalled();
    value.read.resolve([pending]);
    expect(await value.client.approvals.list("session")).toEqual([pending]);
    expect(value.settled).not.toHaveBeenCalled();
    const attached = value.client.approvals.attach(
      "request",
      "session",
      value.socket,
      value.options,
    );
    await value.client.handleCallback("request.accepted", ["request"]);
    value.attachment.resolve(undefined);
    await Promise.all([attached, value.handled]);
    expect(value.settled).toHaveBeenCalledExactlyOnceWith("completed");
    expect(value.call.mock.calls.map(([method]) => method)).toEqual([
      "request.run",
    ]);
  });

  it("keeps direct Stop available before any approval notification or explicit list", async () => {
    const value = fixture();
    await value.client.handleCallback("request.accepted", ["request"]);
    await value.disconnected();
    const stopping = value.client.requests.cancel!("request", "session");
    await Promise.resolve();
    await value.client.handleCallback("request.accepted", ["request"]);
    expect(await stopping).toEqual({ accepted: true });
    expect(value.approvalCall).toHaveBeenCalledExactlyOnceWith(
      "request.attach",
      ["request", "session"],
    );
    expect(value.call).toHaveBeenLastCalledWith("request.cancel", [
      "request",
      "session",
    ]);
    value.attachment.resolve(undefined);
    await value.handled;
  });

  it("settles transport failure only after the exact session snapshot and owner inactivity", async () => {
    const value = fixture();
    await value.disconnected();
    value.read.resolve([{ ...pending, sessionId: "other-session" }]);
    await value.client.approvals.list("other-session");
    expect(value.settled).not.toHaveBeenCalled();
    await value.client.approvals.list("session");
    await value.handled;
    expect(value.call).toHaveBeenLastCalledWith("request.active", [
      "request",
      "session",
    ]);
    expect(value.settled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "local_runtime_connection_lost" }),
    );
  });

  it("retains an active request when an empty approval snapshot precedes the owner's approval wait", async () => {
    const value = fixture();
    await value.disconnected();
    const listing = value.client.approvals.list("session");
    value.active.mockResolvedValue(true);
    value.read.resolve([]);
    await listing;
    expect(value.settled).not.toHaveBeenCalled();
    expect(value.call).toHaveBeenLastCalledWith("request.active", [
      "request",
      "session",
    ]);
    const stopping = value.client.requests.cancel!("request", "session");
    await Promise.resolve();
    await value.client.handleCallback("request.accepted", ["request"]);
    expect(await stopping).toEqual({ accepted: true });
    value.attachment.resolve(undefined);
    await value.handled;
  });

  it("keeps unknown state when the explicit owner activity read loses its connection", async () => {
    const value = fixture();
    await value.disconnected();
    value.read.resolve([]);
    value.active.mockRejectedValueOnce(
      new Error("local_runtime_connection_lost"),
    );
    await expect(value.client.approvals.list("session")).rejects.toThrow(
      "local_runtime_connection_lost",
    );
    expect(value.settled).not.toHaveBeenCalled();
    value.client.close();
    await value.handled;
    expect(value.settled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "local_runtime_stopped" }),
    );
  });

  it("does not let an older empty snapshot discard a newly attached request", async () => {
    const value = fixture();
    await value.disconnected();
    const listing = value.client.approvals.list("session");
    const attached = value.client.approvals.attach(
      "request",
      "session",
      value.socket,
      value.options,
    );
    await value.client.handleCallback("request.accepted", ["request"]);
    await value.client.handleCallback("request.event", [
      "request",
      {
        name: "tool.approval.required",
        approvalId: "approval",
      },
    ]);
    value.read.resolve([]);
    await listing;
    expect(value.settled).not.toHaveBeenCalled();
    value.attachment.resolve(undefined);
    await Promise.all([attached, value.handled]);
    expect(value.settled).toHaveBeenCalledExactlyOnceWith("completed");
  });

  it("does not let an older inactive result discard a newly observed approval", async () => {
    const value = fixture();
    const activityStarted = gate<void>();
    const activityReply = gate<boolean>();
    value.active.mockImplementationOnce(() => {
      activityStarted.resolve(undefined);
      return activityReply.promise;
    });
    await value.disconnected();
    value.read.resolve([]);
    const listing = value.client.approvals.list("session");
    await activityStarted.promise;
    await value.client.handleCallback("request.event", [
      "request",
      {
        name: "tool.approval.required",
        approvalId: "approval",
      },
    ]);
    activityReply.resolve(false);
    await listing;
    expect(value.settled).not.toHaveBeenCalled();
    value.client.close();
    await value.handled;
  });

  it("still sends canonical Stop if another client settles approval before delivery reattachment", async () => {
    const value = fixture();
    await value.client.handleCallback("request.event", [
      "request",
      {
        name: "tool.approval.required",
        approvalId: "approval",
      },
    ]);
    await value.disconnected();
    const stopping = value.client.requests.cancel!("request", "session");
    value.attachment.reject(
      new Error("local_runtime_request_not_awaiting_approval"),
    );
    expect(await stopping).toEqual({ accepted: true });
    expect(value.call).toHaveBeenLastCalledWith("request.cancel", [
      "request",
      "session",
    ]);
    await value.handled;
  });

  it("does not hide a session mismatch when restoring delivery for Stop", async () => {
    const value = fixture();
    await value.client.handleCallback("request.event", [
      "request",
      {
        name: "tool.approval.required",
        approvalId: "approval",
      },
    ]);
    await value.disconnected();
    const stopping = value.client.requests.cancel!("request", "other-session");
    value.attachment.reject(new Error("local_runtime_session_mismatch"));
    await expect(stopping).rejects.toThrow("local_runtime_session_mismatch");
    expect(value.call.mock.calls.map(([method]) => method)).toEqual([
      "request.run",
    ]);
    await value.handled;
  });
});
