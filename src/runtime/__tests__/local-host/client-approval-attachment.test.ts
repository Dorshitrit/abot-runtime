import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type {
  ToolApprovalController,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../../ports.js";
import { LocalRuntimeClientRequests } from "../../local-host/client-requests.js";

const approval: ToolApprovalRequest = {
  requestId: "request",
  approvalId: "approval",
  call: { tool: "test.write", params: {} },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

function approvalController(): ToolApprovalController {
  return {
    requestToolApproval: (_request, options) =>
      new Promise<ToolApprovalDecision>((resolve) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => {
            resolve({ approved: false, reason: "View detached" });
          },
          { once: true },
        );
      }),
  };
}

function socket() {
  return { send: vi.fn() } as unknown as WebSocket;
}

describe("client attachment to a pending owner approval", () => {
  it("keeps the original handle pending on loss, attaches once, and resumes its events without replay", async () => {
    const run = deferred<unknown>();
    const attachment = deferred<unknown>();
    const call = vi.fn(async () => run.promise);
    const attachmentCall = vi.fn(async () => attachment.promise);
    const client = new LocalRuntimeClientRequests(
      call,
      undefined,
      attachmentCall,
    );
    const options = { toolApprovalController: approvalController() };
    const originalSettled = vi.fn();
    const original = client.requests
      .handle(
        socket(),
        {
          type: "run_request",
          requestId: "request",
          sessionId: "session",
          text: "Write the artifact",
        },
        options,
      )
      .then(originalSettled);
    await client.handleCallback("request.accepted", ["request"]);
    const callback = client.handleCallback("request.approval", [approval]);
    client.close(true);
    run.reject(new Error("local_runtime_connection_lost"));
    await callback;
    await Promise.resolve();
    expect(originalSettled).not.toHaveBeenCalled();

    const accepted = vi.fn();
    const replacement = socket();
    const attached = client.approvals.attach(
      "request",
      "session",
      replacement,
      options,
      accepted,
    );
    expect(accepted).not.toHaveBeenCalled();
    await client.handleCallback("request.accepted", ["request"]);
    expect(accepted).toHaveBeenCalledOnce();
    await client.handleCallback("request.event", [
      "request",
      { type: "completed", requestId: "request" },
    ]);
    attachment.resolve(undefined);
    await Promise.all([attached, original]);
    expect(originalSettled).toHaveBeenCalledOnce();
    expect(replacement.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "completed", requestId: "request" }),
    );
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "request.run",
      expect.any(Array),
    );
    expect(attachmentCall).toHaveBeenCalledExactlyOnceWith("request.attach", [
      "request",
      "session",
    ]);
  });

  it("retains a required-approval event if the transport closes before the reverse callback arrives", async () => {
    const run = deferred<unknown>();
    const client = new LocalRuntimeClientRequests(async () => run.promise);
    const settled = vi.fn();
    const pending = client.requests
      .handle(socket(), {
        type: "run_request",
        requestId: "request",
        sessionId: "session",
        text: "Write",
      })
      .catch(settled);
    await client.handleCallback("request.event", [
      "request",
      {
        name: "tool.approval.required",
        approvalId: "approval",
      },
    ]);
    client.close(true);
    run.reject(new Error("local_runtime_connection_lost"));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    client.close();
    await pending;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ message: "local_runtime_stopped" }),
    );
  });

  it("preserves transport failure for requests that were not waiting for approval", async () => {
    const run = deferred<unknown>();
    const client = new LocalRuntimeClientRequests(async () => run.promise);
    const pending = client.requests.handle(socket(), {
      type: "run_request",
      requestId: "request",
      sessionId: "session",
      text: "Answer",
    });
    const rejected = expect(pending).rejects.toThrow(
      "local_runtime_connection_lost",
    );
    client.close(true);
    run.reject(new Error("local_runtime_connection_lost"));
    await rejected;
  });

  it("does not acknowledge a failed attachment as ready for a decision", async () => {
    const client = new LocalRuntimeClientRequests(async () => {
      throw new Error("local_runtime_request_not_active");
    });
    const accepted = vi.fn();
    await expect(
      client.approvals.attach("request", "session", socket(), {}, accepted),
    ).rejects.toThrow("local_runtime_request_not_active");
    expect(accepted).not.toHaveBeenCalled();
  });

  it("routes listing and decisions to the explicit approval connection without replaying request.run", async () => {
    const call = vi.fn();
    const approvalCall = vi.fn(async (method: string) =>
      method === "request.approvals"
        ? [{ sessionId: "session", request: approval }]
        : { accepted: true },
    );
    const client = new LocalRuntimeClientRequests(
      call,
      undefined,
      approvalCall,
    );
    expect(await client.approvals.list("session")).toEqual([
      { sessionId: "session", request: approval },
    ]);
    const decision = {
      requestId: "request",
      sessionId: "session",
      approvalId: "approval",
      approved: true,
    };
    expect(await client.approvals.decide(decision)).toEqual({ accepted: true });
    expect(approvalCall.mock.calls).toEqual([
      ["request.approvals", ["session"]],
      ["request.approval.decide", [decision]],
    ]);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a lost attachment attempt while preserving the original request for a later attachment", async () => {
    const originalRun = deferred<unknown>();
    const lostAttach = deferred<unknown>();
    const completedAttach = deferred<unknown>();
    const approvalCall = vi
      .fn()
      .mockReturnValueOnce(lostAttach.promise)
      .mockReturnValueOnce(completedAttach.promise);
    const client = new LocalRuntimeClientRequests(
      async () => originalRun.promise,
      undefined,
      approvalCall,
    );
    const original = client.requests.handle(socket(), {
      type: "run_request",
      requestId: "request",
      sessionId: "session",
      text: "Write",
    });
    await client.handleCallback("request.event", [
      "request",
      {
        name: "tool.approval.required",
        approvalId: "approval",
      },
    ]);
    client.close(true);
    originalRun.reject(new Error("local_runtime_connection_lost"));
    await Promise.resolve();
    const accepted = vi.fn();
    const firstAttach = client.approvals.attach(
      "request",
      "session",
      socket(),
      {},
      accepted,
    );
    const rejected = expect(firstAttach).rejects.toThrow(
      "local_runtime_connection_lost",
    );
    client.close(true);
    lostAttach.reject(new Error("local_runtime_connection_lost"));
    await rejected;
    expect(accepted).not.toHaveBeenCalled();
    const retry = client.approvals.attach(
      "request",
      "session",
      socket(),
      {},
      accepted,
    );
    await client.handleCallback("request.accepted", ["request"]);
    completedAttach.resolve(undefined);
    await Promise.all([original, retry]);
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("reattaches a failed approval callback even when its wire is still connected", async () => {
    const run = deferred<unknown>();
    const completedAttach = deferred<unknown>();
    const approvalCall = vi.fn(async () => completedAttach.promise);
    const client = new LocalRuntimeClientRequests(
      async () => run.promise,
      undefined,
      approvalCall,
    );
    const original = client.requests.handle(
      socket(),
      {
        type: "run_request",
        requestId: "request",
        sessionId: "session",
        text: "Write",
      },
      {
        toolApprovalController: {
          requestToolApproval: async () => {
            throw new Error("view_failed");
          },
        },
      },
    );
    await client.handleCallback("request.accepted", ["request"]);
    await expect(
      client.handleCallback("request.approval", [approval]),
    ).rejects.toThrow("view_failed");
    const attached = client.approvals.attach("request", "session", socket(), {
      toolApprovalController: approvalController(),
    });
    expect(approvalCall).toHaveBeenCalledExactlyOnceWith("request.attach", [
      "request",
      "session",
    ]);
    await client.handleCallback("request.accepted", ["request"]);
    run.resolve(undefined);
    completedAttach.resolve(undefined);
    await Promise.all([original, attached]);
  });

  it("uses explicit same-owner attachment for Stop on a disconnected pending approval", async () => {
    const run = deferred<unknown>();
    const attachment = deferred<unknown>();
    const approvalCall = vi.fn(async () => attachment.promise);
    const call = vi.fn(async (method: string) =>
      method === "request.cancel" ? { accepted: true } : run.promise,
    );
    const client = new LocalRuntimeClientRequests(
      call,
      undefined,
      approvalCall,
    );
    const original = client.requests
      .handle(socket(), {
        type: "run_request",
        requestId: "request",
        sessionId: "session",
        text: "Write",
      })
      .catch(() => {});
    await client.handleCallback("request.event", [
      "request",
      {
        name: "tool.approval.required",
        approvalId: "approval",
      },
    ]);
    client.close(true);
    run.reject(new Error("local_runtime_connection_lost"));
    const cancelled = client.requests.cancel!("request", "session");
    await Promise.resolve();
    await client.handleCallback("request.accepted", ["request"]);
    expect(await cancelled).toEqual({ accepted: true });
    expect(approvalCall).toHaveBeenCalledExactlyOnceWith("request.attach", [
      "request",
      "session",
    ]);
    expect(call).toHaveBeenLastCalledWith("request.cancel", [
      "request",
      "session",
    ]);
    attachment.resolve(undefined);
    await original;
  });
});
