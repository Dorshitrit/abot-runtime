import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { RuntimeRequestOptions } from "../../runtime/composition.js";
import type { SchedulerRun } from "../../runtime/scheduler/contracts.js";
import type { RuntimeEnvironment } from "./contracts.js";
import { RequestActivity } from "./request-activity.js";
import { LocalRequestExecution } from "./request-execution.js";
import { RealtimeClientHub } from "./realtime-hub.js";

const scope = { requestId: "request", sessionId: "session", environment: "dev" };
function lifecycle(status: string, revision: number) {
  return { type: "event", name: "request.lifecycle.changed", ...scope,
    lifecycle: { schemaVersion: 1, requestId: scope.requestId, sessionId: scope.sessionId,
      generation: "generation", revision, status } };
}
function fixture(observer?: (event: Record<string, unknown>) => void) {
  return new LocalRequestExecution(new RealtimeClientHub(observer));
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("health sees continuation activity before realtime and workspace callbacks, without execution handles", () => {
  const snapshots: Record<string, unknown>[][] = [];
  const requests = fixture(() => snapshots.push(requests.activityDetails()));
  requests.publishScheduled(lifecycle("streaming", 3));
  expect(snapshots).toHaveLength(2);
  for (const snapshot of snapshots) expect(snapshot).toEqual([expect.objectContaining(scope)]);
  expect(requests.healthDetails()).toEqual([]);
  expect(requests.activeReplay(scope.requestId, 0)).toBeUndefined();
});

test("canonical pause and terminal suppress a still-unsettled handle without changing control inventory", () => {
  const requests = fixture();
  requests.scheduledRequestOptions({ requestId: scope.requestId, sessionId: scope.sessionId,
    environmentId: scope.environment } as SchedulerRun);
  requests.publishScheduled(lifecycle("streaming", 1));
  expect(requests.activityDetails()).toHaveLength(1);
  requests.publishScheduled(lifecycle("awaiting_approval", 2));
  expect(requests.activityDetails()).toEqual([]);
  expect(requests.healthDetails()).toHaveLength(1);
  requests.publishScheduled(lifecycle("streaming", 3));
  expect(requests.activityDetails()).toHaveLength(1);
  requests.publishScheduled(lifecycle("completed", 4));
  expect(requests.activityDetails()).toEqual([]);
  expect(requests.healthDetails()).toHaveLength(1);
  requests.publishScheduled({ type: "completed", ...scope });
  expect(requests.activityDetails()).toEqual([]);
  expect(requests.healthDetails()).toEqual([]);
});

test.each(["awaiting_approval", "completed", "failed"])("%s removes observed-only continuation activity", (status) => {
  const requests = fixture();
  requests.publishScheduled(lifecycle("streaming", 3));
  requests.publishScheduled(lifecycle(status, 4));
  expect(requests.activityDetails()).toEqual([]);
});

test("deleted-session terminal cleans activity even when delivery is suppressed", () => {
  const observer = vi.fn();
  const requests = fixture(observer);
  requests.publishScheduled(lifecycle("streaming", 3));
  observer.mockClear();
  requests.publishScheduled({ type: "failed", ...scope, sessionDeleted: true });
  expect(observer).not.toHaveBeenCalled();
  expect(requests.activityDetails()).toEqual([]);
});

test("ordinary events refresh timestamps but cannot start activity", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const requests = fixture();
  const delta = { type: "event", name: "thinking.delta", ...scope, delta: "part" };
  requests.publishScheduled(delta);
  expect(requests.activityDetails()).toEqual([]);
  requests.publishScheduled(lifecycle("streaming", 3));
  vi.setSystemTime(1100);
  requests.publishScheduled(delta);
  vi.setSystemTime(1200);
  expect(requests.activityDetails()).toEqual([{ ...scope, startedAt: 1000,
    lastEventAt: 1100, lastEventName: "thinking.delta", idleMs: 100 }]);
});

test.each([
  { schemaVersion: 2 }, { requestId: "other" }, { sessionId: "other" },
  { generation: "" }, { revision: -1 }, { revision: 1.5 }, { revision: "3" }, { status: "unknown" },
])("rejects invalid lifecycle scope and version %j", (invalid) => {
  const requests = fixture();
  const event = lifecycle("streaming", 3);
  requests.publishScheduled({ ...event, lifecycle: { ...event.lifecycle, ...invalid } });
  expect(requests.activityDetails()).toEqual([]);
});

test("scope isolation and lifecycle ordering preserve the current generation", () => {
  const requests = fixture();
  const event = lifecycle("streaming", 3);
  requests.publishScheduled({ ...event, generation: "mismatched" });
  expect(requests.activityDetails()).toEqual([]);
  requests.publishScheduled(event);
  requests.publishScheduled({ type: "failed", ...scope, generation: "other" });
  requests.publishScheduled(lifecycle("awaiting_approval", 2));
  requests.publishScheduled({ ...lifecycle("failed", 4), lifecycle: { ...event.lifecycle, generation: "other", revision: 4, status: "failed" } });
  requests.publishScheduled({ type: "completed", ...scope, environment: "other" });
  requests.publishScheduled({ type: "completed", ...scope, sessionId: "other" });
  expect(requests.activityDetails()).toEqual([expect.objectContaining(scope)]);
  requests.publishScheduled({ ...event, environment: "other" });
  expect(requests.activityDetails()).toHaveLength(2);
  requests.publishScheduled({ type: "completed", ...scope });
  expect(requests.activityDetails()).toEqual([expect.objectContaining({ ...scope, environment: "other" })]);
});

test("partial terminal scope cannot override explicit identity mismatches", () => {
  const requests = fixture();
  requests.scheduledRequestOptions({ requestId: scope.requestId, sessionId: scope.sessionId,
    environmentId: scope.environment } as SchedulerRun);
  requests.publishScheduled(lifecycle("streaming", 3));
  requests.publishScheduled({ type: "failed", requestId: scope.requestId, environment: "other" });
  expect(requests.activityDetails()).toEqual([expect.objectContaining(scope)]);
});

test.each(["completed", "attachment_error"])("approval attachment %s releases its inactive override", async (outcome) => {
  const requests = fixture();
  const release = vi.spyOn(RequestActivity.prototype, "release");
  let socket!: WebSocket;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const environment = {
    approvals: {
      attach: vi.fn((
        _requestId: string,
        _sessionId: string,
        ws: WebSocket,
        _options?: RuntimeRequestOptions,
        onAccepted?: () => void,
      ) => {
        socket = ws;
        socket.send(JSON.stringify(lifecycle("streaming", 1)));
        onAccepted?.();
        return completion;
      }),
    },
  } as unknown as RuntimeEnvironment;
  await requests.attachToolApproval(scope.environment, environment, {
    sessionId: scope.sessionId,
    request: { requestId: scope.requestId, approvalId: "approval",
      call: { tool: "inspect_target", params: {} } },
  }, []);
  expect(requests.activityDetails()).toEqual([expect.objectContaining(scope)]);
  socket.send(JSON.stringify(lifecycle(outcome === "completed" ? "completed" : "awaiting_approval", 2)));
  if (outcome === "completed") {
    socket.send(JSON.stringify({ type: "completed", ...scope, output: "done" }));
  }
  expect(requests.activityDetails()).toEqual([]);
  expect(requests.healthDetails()).toHaveLength(1);
  expect(release).not.toHaveBeenCalled();
  if (outcome === "completed") finish();
  else fail(new Error("attachment lost"));
  await vi.waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    requestId: scope.requestId, sessionId: scope.sessionId, environmentId: scope.environment,
  })));
  expect(requests.healthDetails()).toEqual([]);
  expect(requests.activityDetails()).toEqual([]);
  expect(requests.activeReplay(scope.requestId, 0)).toBeUndefined();
});
