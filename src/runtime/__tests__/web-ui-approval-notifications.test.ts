import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { describe, expect, test, vi } from "vitest";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import type { ActiveRequest } from "../../web-ui/local-runtime/contracts.js";
import { PendingToolApprovals } from "../../web-ui/local-runtime/pending-tool-approvals.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import { createWorkspaceChangeNotifier } from "../../web-ui/local-runtime/workspace-notifications.js";

const identity = {
  requestId: "pending-request",
  sessionId: "pending-session",
  environmentId: "prod",
  approvalId: "pending-approval",
};
const required = {
  type: "event",
  name: "tool.approval.required",
  ...identity,
  environment: identity.environmentId,
};
const request = {
  requestId: identity.requestId,
  approvalId: identity.approvalId,
  call: { tool: "fixture_tool", input: {} } as never,
};

function activeRequest(): ActiveRequest {
  return {
    ...identity,
    startedAt: 1,
    lastEventAt: 1,
    lastEventName: "tool.approval.required",
    finalState: null,
    events: [required],
    requestSteering: createRequestSteeringInbox({
      requestId: identity.requestId,
    }),
  };
}

function client(onFrame: (frame: Record<string, unknown>) => void) {
  return Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send(raw: string) {
      onFrame(JSON.parse(raw));
    },
  }) as unknown as WebSocket;
}

describe("post-mutation Web approval notifications", () => {
  test("observers see registered and removed authority, with no duplicate resolution event", async () => {
    const observed: number[] = [];
    const approvals = new PendingToolApprovals(
      () => activeRequest(),
      (requestId) => {
        expect(requestId).toBe(identity.requestId);
        observed.push(approvals.list("prod").length);
      },
    );
    const decision = approvals.requestToolApproval(request);
    expect(observed).toEqual([1]);
    expect(approvals.decide({ ...identity, approved: true })).toBe(true);
    expect(observed).toEqual([1, 0]);
    expect(await decision).toEqual({ approved: true });
    expect(approvals.decide({ ...identity, approved: false })).toBe(false);
    expect(observed).toEqual([1, 0]);
  });

  test("abort reports removal after registration; an already aborted call emits nothing", async () => {
    const observed: number[] = [];
    const approvals = new PendingToolApprovals(
      () => activeRequest(),
      () => observed.push(approvals.list("prod").length),
    );
    const aborter = new AbortController();
    const decision = approvals.requestToolApproval(request, {
      abortSignal: aborter.signal,
    });
    aborter.abort();
    expect(await decision).toMatchObject({ approved: false });
    expect(observed).toEqual([1, 0]);
    expect(
      await approvals.requestToolApproval(request, {
        abortSignal: aborter.signal,
      }),
    ).toMatchObject({ approved: false });
    expect(observed).toEqual([1, 0]);
  });

  test("observer failure cannot strand or reverse an approval decision", async () => {
    const approvals = new PendingToolApprovals(
      () => activeRequest(),
      () => {
        throw new Error("disconnected observer");
      },
    );
    const decision = approvals.requestToolApproval(request);
    expect(approvals.list("prod")).toHaveLength(1);
    approvals.resolveRealtime({
      approvalId: identity.approvalId,
      approved: false,
    });
    expect(await decision).toMatchObject({ approved: false });
    expect(approvals.list("prod")).toEqual([]);
  });

  test("all connected browsers receive refresh signals after authority changes, outside request replay", async () => {
    const hub = new RealtimeClientHub();
    const execution = new LocalRequestExecution(hub);
    const first: Record<string, unknown>[] = [];
    const second: Record<string, unknown>[] = [];
    const visibleCounts: number[] = [];
    hub.add(
      client((frame) => {
        first.push(frame);
        if (frame.type === "workspace_changed") {
          visibleCounts.push(execution.toolApprovals.list("prod").length);
        }
      }),
    );
    hub.add(client((frame) => second.push(frame)));
    const run: SchedulerRun = {
      ...identity,
      id: "run",
      jobId: "job",
      title: "Fixture",
      prompt: "Unused",
      modelProfileId: "fixture",
      agentMode: "fast",
      timeZone: "UTC",
      jobRevision: 1,
      scheduledAt: "2026-09-22T00:00:00Z",
      trigger: "manual",
      status: "running",
    };
    const options = execution.scheduledRequestOptions(run);
    execution.publishScheduled(required);
    expect(execution.toolApprovals.list("prod")).toEqual([]);
    expect(first.filter((frame) => frame.type === "workspace_changed")).toEqual(
      [],
    );
    const decision =
      options.toolApprovalController!.requestToolApproval(request);
    execution.resolveToolApproval({
      approvalId: identity.approvalId,
      approved: true,
    });
    expect(await decision).toMatchObject({ approved: true });
    expect(visibleCounts).toEqual([1, 0]);
    expect(first).toEqual(second);
    expect(first.filter((frame) => frame.type === "workspace_changed")).toEqual(
      [
        {
          type: "workspace_changed",
          environment: "prod",
          resources: ["approvals"],
        },
        {
          type: "workspace_changed",
          environment: "prod",
          resources: ["approvals"],
        },
      ],
    );
    expect(
      execution.activeReplayForSession(
        identity.requestId,
        identity.sessionId,
        "prod",
      ),
    ).toEqual([required]);
  });

  test("failed delivery cannot reject a committed workspace change", () => {
    const broadcast = vi.fn(() => {
      throw new Error("closed socket");
    });
    const notify = createWorkspaceChangeNotifier({ broadcast });
    expect(() => notify("dev", ["sessions"])).not.toThrow();
    expect(broadcast).toHaveBeenCalledWith({
      type: "workspace_changed",
      environment: "dev",
      resources: ["sessions"],
    });
  });

  test("a failed browser cannot block later workspace notifications", () => {
    const hub = new RealtimeClientHub();
    const failedDelivery = vi.fn(() => {
      throw new Error("closed socket");
    });
    const received: Record<string, unknown>[] = [];
    hub.add(client(failedDelivery));
    hub.add(client((frame) => received.push(frame)));

    const notify = createWorkspaceChangeNotifier(hub);
    notify("dev", ["sessions"]);
    notify("dev", ["approvals"]);

    expect(failedDelivery).toHaveBeenCalledTimes(1);
    expect(received).toEqual([
      {
        type: "workspace_changed",
        environment: "dev",
        resources: ["sessions"],
      },
      {
        type: "workspace_changed",
        environment: "dev",
        resources: ["approvals"],
      },
    ]);
  });
});
