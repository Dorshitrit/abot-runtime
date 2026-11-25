import { afterEach, expect, test, vi } from "vitest";
import { createAgentWorkspaceApprovals } from "../agents/workspace-approvals.js";
import type { OrdinaryAgentSessionPort } from "../agents/ordinary-session-port.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import type { SessionRequestLifecycleStore } from "../../sessions/request-lifecycle/contracts.js";
import { agentApplicationFixture, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures);
const previousDecision = { approvalId: "approval", approved: true, generation: "previous-generation", revision: 4, waitId: "old-wait", commandId: "original" };
async function fixture() {
  const f = await agentApplicationFixture();
  await f.app.send("agent-a", { messageId: "user", text: "Check the reference.", intent: "task" });
  await f.app.whenIdle();
  const detail = await f.app.detail("agent-a"), old = detail.attempts[0]!;
  const next = { ...old, id: "new-attempt", missionId: "current", status: "awaiting_approval" as const, request: { ...old.request,
    attemptId: "new-attempt", missionId: "current", requestId: "new-request", sessionId: "new-session", toolPermissionMode: "full_plus" as const } };
  const current = { ...detail, mission: { ...detail.mission!, id: "current", status: "active" as const }, attempts: [old, next] };
  const application = { detail: vi.fn(async () => current) };
  const waiting = { sessionId: next.request.sessionId, request: { requestId: next.request.requestId, approvalId: "approval" },
    wait: { waitId: "new-wait", generation: "new-generation", revision: 4 } } as LocalPendingToolApproval;
  const work = { listApprovals: vi.fn<OrdinaryAgentSessionPort["listApprovals"]>(async () => [waiting]),
    decideApproval: vi.fn<OrdinaryAgentSessionPort["decideApproval"]>(async () => ({ accepted: true })) };
  const receipt = { ...previousDecision, requestId: old.request.requestId, revision: 5, committedAt: old.updatedAt };
  const getDecisionReceipt = vi.fn<SessionRequestLifecycleStore["getDecisionReceipt"]>(async (sessionId, requestId, generation, commandId) =>
    sessionId === old.request.sessionId && requestId === old.request.requestId &&
    generation === receipt.generation && commandId === receipt.commandId ? receipt : null);
  const service = createAgentWorkspaceApprovals(application, work, { requestLifecycle: { getDecisionReceipt } as unknown as SessionRequestLifecycleStore });
  return { service, work, waiting, next, old, getDecisionReceipt, current };
}
test("same Agent, same display approval ID, different missions: replay only the committed original intent", async () => {
  const f = await fixture();
  f.work.listApprovals.mockRejectedValue(new Error("new request unavailable"));
  await f.service.decide("agent-a", previousDecision, ["ask"]);
  expect(f.work.listApprovals).not.toHaveBeenCalled();
  expect(f.getDecisionReceipt).toHaveBeenCalledWith(f.old.request.sessionId, f.old.request.requestId, previousDecision.generation, previousDecision.commandId);
  for (const delta of [{ approved: false }, { reason: "different" }, { revision: 5 }, { waitId: "different" }]) {
    await expect(f.service.decide("agent-a", { ...previousDecision, ...delta })).rejects.toThrow("approval_conflict");
  }
  expect(f.work.decideApproval).not.toHaveBeenCalled();
});
test("a new approval requires the exact pending identity and the attempt's permission mode before resuming", async () => {
  const f = await fixture();
  const decision = { ...previousDecision, ...f.waiting.wait, commandId: "new-command" };
  expect(await f.service.list("agent-a")).toEqual([f.waiting]);
  await expect(f.service.decide("agent-a", { approvalId: "approval", approved: true, generation: "partial" })).rejects.toThrow("agents_input_approval_identity");
  await expect(f.service.decide("agent-a", decision, ["ask"])).rejects.toThrow("agents_permission_denied");
  await expect(f.service.decide("agent-a", { ...decision, revision: 6 }, ["ask", "full_access", "full_plus"])).rejects.toThrow("approval_conflict");
  expect(f.work.decideApproval).not.toHaveBeenCalled();
  await f.service.decide("agent-a", decision, ["ask", "full_access", "full_plus"]);
  expect(f.work.decideApproval).toHaveBeenCalledExactlyOnceWith(f.next.request, decision);
});
test("a stale legacy attempt from an earlier mission cannot appear in the current Agent approval list", async () => {
  const f = await fixture();
  f.current.attempts = [{ ...f.old, status: "awaiting_approval" }];
  expect(await f.service.list("agent-a")).toEqual([]);
  await expect(f.service.decide("agent-a", { approvalId: "approval", approved: true })).rejects.toThrow("agents_approval_not_found");
  expect(f.work.listApprovals).not.toHaveBeenCalled();
  expect(f.work.decideApproval).not.toHaveBeenCalled();
});
