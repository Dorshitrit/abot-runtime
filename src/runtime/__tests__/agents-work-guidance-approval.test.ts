import type { ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { createOrdinaryAgentSessionPort } from "../agents/ordinary-session-port.js";
import type { AgentWorkRequest } from "../agents/application-contracts.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createWebSavedApprovalSteeringFixture } from "./support/web-saved-approval-steering-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s: soft guidance racing a saved ASK wait cannot release the tool", async policy => {
    const f = await createWebSavedApprovalSteeringFixture(policy, cleanup);
    if (policy === "execution-agent-v1") {
      const script = f.model.invoke.getMockImplementation()!;
      let needsTitle = true;
      f.model.invoke.mockImplementation(async input => {
        const result = await script(input);
        if (input.modelStep !== "execution.decision" || !needsTitle) return result;
        needsTitle = false;
        const reply = JSON.parse(result.text);
        return { ...result, text: JSON.stringify({ ...reply, decision: { ...reply.decision, title: "Approval fixture" } }) };
      });
    }
    const responses: Record<string, unknown>[] = [];
    const response = { writeHead: vi.fn(), end: (raw: string) => responses.push(JSON.parse(raw)) } as unknown as ServerResponse;
    await f.requests.start(response, { sessionId: "guidance-session", text: "Perform the fixture action.", toolPermissionMode: "ask",
      agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" } }, f.base.config.runtimeId, f.client);
    const requestId = String(responses[0]!.requestId);
    await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ name: "request.lifecycle.changed",
      lifecycle: expect.objectContaining({ status: "awaiting_approval" }) })), { timeout: 5000 });
    await vi.waitFor(() => expect(f.owner.isIdle?.()).toBe(true));
    const sessions = f.client.services.sessions;
    const saved = await sessions.getRequestReplayById(requestId, 0, "guidance-session");
    expect(saved?.lifecycle?.status).toBe("awaiting_approval");
    const before = f.model.invoke.mock.calls.length;
    const pending = await f.approvals.list(f.base.config.runtimeId);
    expect(pending).toHaveLength(1);
    const steer = vi.fn(f.client.requests.steer!);
    const port = createOrdinaryAgentSessionPort({ sessions: {
      getOrCreateSession: id => sessions.getOrCreateSession(id), getSessionById: id => sessions.getSessionById(id),
      // The observation preceded parking; the actual owner already sealed this request.
      getRequestReplayById: async () => ({ ...saved!, lifecycle: { ...saved!.lifecycle!, status: "streaming" } }),
    }, requests: { ...f.client.requests, steer } });
    const request: AgentWorkRequest = { agentId: "agent", missionId: "mission", attemptId: "attempt", requestId,
      sessionId: "guidance-session", assignment: "Perform the fixture action.", modelProfileId: "scheduled-model", toolPermissionMode: "ask" };
    expect(await port.adviseWrapUp!(request)).toBe("deferred");
    expect(steer).toHaveBeenCalledOnce();
    expect(await f.approvals.list(f.base.config.runtimeId)).toEqual(pending);
    expect(f.model.invoke).toHaveBeenCalledTimes(before);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.approvals.decide({ ...pending[0]!, commandId: "explicit-human-approval", approved: true })).toBe(true);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    f.effect.open();
    await f.owner.whenIdle?.();
    expect(f.execute).toHaveBeenCalledOnce();
  }, 20_000,
);
