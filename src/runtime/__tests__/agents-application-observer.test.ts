import { expect, test, vi, afterEach } from "vitest";
import { createAgentApplicationObserver } from "../agents/application-observer.js";
import type { AgentApplicationDetail } from "../agents/application-contracts.js";
afterEach(() => vi.useRealTimers());
function view(id: string, status: AgentApplicationDetail["status"], missionStatus = "active"): AgentApplicationDetail {
  return { agent: { id }, status, mission: { status: missionStatus } } as unknown as AgentApplicationDetail;
}
test("accepted work continues to be inspected with no browser connected; waiting and terminal tasks stay parked", async () => {
  vi.useFakeTimers();
  const snapshot = vi.fn(async () => ({ revision: 1, agents: [view("work", "working"), view("approval", "awaiting_approval"), view("thinking", "thinking"), view("unknown", "awaiting_user_decision", "awaiting_user_decision"), view("done", "idle", "completed")] }));
  const refresh = vi.fn(async (_id: string) => view("work", "working"));
  const observer = createAgentApplicationObserver({ application: { snapshot, refresh } });
  await observer.start(); expect(refresh.mock.calls).toEqual([["work"], ["approval"]]);
  await vi.advanceTimersByTimeAsync(1000); expect(refresh).toHaveBeenCalledTimes(4);
  await observer.stop(); await vi.advanceTimersByTimeAsync(1000); expect(refresh).toHaveBeenCalledTimes(4);
});
test("overlapping observer ticks do not inspect the same task concurrently", async () => {
  vi.useFakeTimers(); let release!: (value: AgentApplicationDetail) => void;
  const refresh = vi.fn(() => new Promise<AgentApplicationDetail>((resolve) => { release = resolve; }));
  const observer = createAgentApplicationObserver({ application: { snapshot: async () => ({ revision: 1, agents: [view("work", "working")] }), refresh } });
  const started = observer.start(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(3000); expect(refresh).toHaveBeenCalledTimes(1);
  release(view("work", "working")); await started; await observer.stop();
});
test("receipt read failure is reported once and never treated as permission to launch work", async () => {
  vi.useFakeTimers(); const refresh = vi.fn(); const onError = vi.fn();
  const observer = createAgentApplicationObserver({ application: { snapshot: vi.fn().mockRejectedValue(new Error("unreadable")), refresh }, onError });
  await observer.start(); await observer.tick(); expect(onError).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled(); await observer.stop();
});
