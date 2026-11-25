import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import type { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { LocalRealtimeController } from "../../web-ui/local-runtime/realtime-controller.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import { ManagedWebToolApprovals } from "../../web-ui/local-runtime/managed-tool-approvals.js";
import { agentsWebBoundaryFixture } from "./support/agents-web-boundary-fixture.js";
const fixtures: Awaited<ReturnType<typeof agentsWebBoundaryFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
async function fixture(sessionId = "agent-new") {
  const f = await agentsWebBoundaryFixture(); fixtures.push(f);
  const event = { type: "event", name: "tool.approval.required", requestId: "work-request", approvalId: "approval", sessionId };
  const replay = vi.spyOn(f.sessions, "getRequestReplayById").mockResolvedValue({ requestId: "work-request", sessionId,
    events: [event], finalState: { status: "completed", output: "Private agent work", completedAt: 1 } });
  const approvals = { list: vi.fn(async () => [{ sessionId, request: { requestId: "work-request", approvalId: "approval", call: { tool: "fixture", params: {} } } }]),
    decide: vi.fn(async () => ({ accepted: true as const })), attach: vi.fn(async () => {}) };
  const environment = { ...f.environment, approvals };
  const hub = new RealtimeClientHub(); const requests = new LocalRequestExecution(hub);
  const steer = vi.spyOn(requests, "handleSteer");
  const sent: Record<string, unknown>[] = [];
  const socket = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send(raw: string) { sent.push(JSON.parse(raw)); } });
  new LocalRealtimeController({ defaultEnvironmentId: "dev" }, { get: () => environment } as unknown as RuntimeEnvironmentRegistry,
    requests, hub).connect(socket as unknown as WebSocket);
  const managed = new ManagedWebToolApprovals(() => environment, requests);
  return { ...f, replay, approvals, sent, steer, managed, emit(message: unknown) { socket.emit("message", JSON.stringify(message)); } };
}

test("websocket resume denies an explicit Agent session before reading or attaching", async () => {
  const f = await fixture(); f.emit({ type: "resume_request", environment: "dev", requestId: "work-request", sessionId: "agent-new" });
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(f.sent[0]).toMatchObject({ type: "control", error: "agent_session_requires_agents_workspace" });
  expect(f.replay).not.toHaveBeenCalled(); expect(f.approvals.list).not.toHaveBeenCalled(); expect(f.approvals.attach).not.toHaveBeenCalled();
});

test.each([undefined, "chat-new"])("resume with hint %s cannot reveal an authoritative Agent replay", async (sessionId) => {
  const f = await fixture(); f.emit({ type: "resume_request", environment: "dev", requestId: "work-request", sessionId });
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(f.sent[0]).toMatchObject({ type: "control", error: "agent_session_requires_agents_workspace" });
  expect(f.approvals.list).not.toHaveBeenCalled(); expect(f.approvals.attach).not.toHaveBeenCalled();
  expect(JSON.stringify(f.sent)).not.toContain("Private agent work");
});

test("ordinary websocket replay still returns its original events and final result", async () => {
  const f = await fixture("chat-new"); f.emit({ type: "resume_request", environment: "dev", requestId: "work-request", sessionId: "chat-new" });
  await vi.waitFor(() => expect(f.sent).toHaveLength(2));
  expect(f.sent[1]).toMatchObject({ type: "completed", requestId: "work-request", sessionId: "chat-new", output: "Private agent work" });
});

test("steering an Agent request is refused before the ordinary steering path", async () => {
  const f = await fixture(); f.emit({ type: "steer_request", environment: "dev", requestId: "work-request", steerId: "steer", text: "Change work" });
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(f.sent[0]).toMatchObject({ error: "agent_session_requires_agents_workspace" });
  expect(f.steer).not.toHaveBeenCalled();
});

test("Chat approval listing and legacy approval-ID replies exclude Agent work", async () => {
  const f = await fixture(); expect(await f.managed.list("dev")).toEqual([]);
  expect(f.replay).not.toHaveBeenCalled();
  expect(await f.managed.resolveRealtime({ approved: true, approvalId: "approval", environment: "dev" }, "dev")).toBe(false);
  expect(f.approvals.decide).not.toHaveBeenCalled(); expect(f.approvals.attach).not.toHaveBeenCalled();
});

test("an explicit Chat approval decision cannot bypass Agent ownership", async () => {
  const f = await fixture(); await expect(f.managed.decide({ environmentId: "dev", sessionId: "agent-new", requestId: "work-request",
    approvalId: "approval", approved: true })).rejects.toThrow("agent_session_requires_agents_workspace");
  expect(f.approvals.list).not.toHaveBeenCalled(); expect(f.approvals.decide).not.toHaveBeenCalled();
});

test("legacy approval attachment cannot bypass ownership when no replay was found", async () => {
  const f = await fixture(); await expect(f.managed.resume("dev", "work-request")).rejects.toThrow("agent_session_requires_agents_workspace");
  expect(f.approvals.attach).not.toHaveBeenCalled();
});

test("Chats cannot see an Agent approval admitted during the pending-list read", async () => {
  const f = await fixture("newly-bound");
  const original = f.approvals.list.getMockImplementation()!;
  f.approvals.list.mockImplementationOnce(async () => {
    await f.store.commitApplication({ kind: "bind_session", agentId: "agent-a", sessionId: "newly-bound", purpose: "New work" });
    return original();
  });
  expect(await f.managed.list("dev")).toEqual([]);
  expect(f.replay).not.toHaveBeenCalled();
});
