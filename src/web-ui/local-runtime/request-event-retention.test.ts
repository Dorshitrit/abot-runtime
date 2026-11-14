import { expect, test } from "vitest";
import type { SchedulerRun } from "../../runtime/scheduler/contracts.js";
import { LocalRequestExecution } from "./request-execution.js";
import { RealtimeClientHub } from "./realtime-hub.js";

test("live delivery keeps all updates while active replay retains cumulative tails and receipts", () => {
  const delivered: Record<string, unknown>[] = [];
  const requests = new LocalRequestExecution(new RealtimeClientHub((event) => delivered.push(event)));
  requests.scheduledRequestOptions({ requestId: "request", sessionId: "session", environmentId: "dev" } as SchedulerRun);
  const event = (seq: number, text: string, delta: string) => ({
    type: "event", name: "thinking.delta", requestId: "request", sessionId: "session", environment: "dev",
    text, delta, seqNo: seq, eventSequence: seq,
  });
  const first = event(1, "a", "a");
  const second = event(2, "ab", "b");
  const receipt = { type: "event", name: "tool.completed", requestId: "request", eventSequence: 3, receipt: "file-output" };
  const third = event(4, "abc", "c");
  for (const payload of [first, second, receipt, third]) requests.publishScheduled(payload);
  expect(delivered).toEqual([first, second, receipt, third]);
  expect(requests.activeReplay("request", 0)?.events).toEqual([second, receipt, third]);
  expect(requests.activeReplay("request", 2)?.events).toEqual([receipt, third]);
  expect(requests.activeReplayForSession("request", "session", "dev")).toEqual([second, receipt, third]);
  expect(requests.activeReplayForSession("request", "other-session", "dev")).toBeUndefined();
  requests.publishScheduled({ type: "completed", requestId: "request", output: "done" });
  expect(requests.activeReplay("request", 0)).toBeUndefined();
});
