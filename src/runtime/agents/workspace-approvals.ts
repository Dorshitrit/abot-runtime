import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { SessionApprovalDecisionReceipt } from "../../sessions/request-lifecycle/contracts.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import type { SessionStore } from "../ports.js";
import type { AgentApplicationDetail, AgentApplicationService } from "./application-contracts.js";
import type { OrdinaryAgentSessionPort } from "./ordinary-session-port.js";
import { remoteAgentRevision, remoteAgentText, requireRemoteAgentMode } from "./remote-workspace-input.js";

type WaitIdentity = Readonly<{ generation: string; waitId: string; revision: number; commandId: string }>;
type Approval = { approvalId: string; approved: boolean; reason?: string };
type Modes = readonly ToolPermissionMode[];

function readDecision(input: Record<string, unknown>): { decision: Approval; wait?: WaitIdentity } {
  if (typeof input?.approved !== "boolean") throw new Error("agents_input_approval");
  const decision = { approvalId: remoteAgentText(input.approvalId, 512, "approval_id"), approved: input.approved,
    ...(input.reason === undefined ? {} : { reason: remoteAgentText(input.reason, 1000, "reason") }) };
  const fields = ["generation", "waitId", "revision", "commandId"].filter(key => input[key] !== undefined);
  if (fields.length === 0) return { decision };
  if (fields.length !== 4) throw new Error("agents_input_approval_identity");
  return { decision, wait: { generation: remoteAgentText(input.generation, 256, "generation"),
    waitId: remoteAgentText(input.waitId, 256, "wait_id"), revision: remoteAgentRevision(input.revision),
    commandId: remoteAgentText(input.commandId, 256, "command_id") } };
}
function currentApprovalAttempt(detail: AgentApplicationDetail) {
  if (detail.mission?.status !== "active") return undefined;
  return [...detail.attempts].reverse().find(attempt => attempt.missionId === detail.mission?.id &&
    ["awaiting_approval", "running", "claimed"].includes(attempt.status) && !attempt.userResolved);
}
function matchesPending(item: LocalPendingToolApproval, decision: Approval, wait?: WaitIdentity): boolean {
  if (item.request.approvalId !== decision.approvalId) return false;
  if (!wait || !item.wait) return !wait && !item.wait;
  return item.wait.waitId === wait.waitId && item.wait.generation === wait.generation && item.wait.revision === wait.revision;
}
function matchesReceipt(receipt: SessionApprovalDecisionReceipt, requestId: string, decision: Approval, wait: WaitIdentity) {
  return receipt.requestId === requestId && receipt.commandId === wait.commandId && receipt.generation === wait.generation &&
    receipt.waitId === wait.waitId && receipt.approvalId === decision.approvalId && receipt.approved === decision.approved &&
    receipt.reason === decision.reason && receipt.revision === wait.revision + 1;
}

/** An approval retry can observe its original receipt after the Agent has moved on to another mission. */
export function createAgentWorkspaceApprovals(application: Pick<AgentApplicationService, "detail">,
  work: Pick<OrdinaryAgentSessionPort, "listApprovals" | "decideApproval">, sessions: Pick<SessionStore, "requestLifecycle">) {
  async function alreadyDecided(detail: AgentApplicationDetail, decision: Approval, wait: WaitIdentity, allowedModes?: Modes) {
    const lifecycle = sessions.requestLifecycle;
    if (!lifecycle) return false;
    for (const attempt of [...detail.attempts].reverse()) {
      const request = attempt.request;
      const receipt = await lifecycle.getDecisionReceipt(request.sessionId, request.requestId, wait.generation, wait.commandId);
      if (!receipt) continue;
      if (allowedModes) requireRemoteAgentMode(request.toolPermissionMode, allowedModes);
      if (!matchesReceipt(receipt, request.requestId, decision, wait)) throw new Error("approval_conflict");
      return true;
    }
    return false;
  }
  return {
    async list(agentId: string): Promise<readonly LocalPendingToolApproval[]> {
      const attempt = currentApprovalAttempt(await application.detail(agentId));
      return attempt ? work.listApprovals(attempt.request) : [];
    },
    async decide(agentId: string, input: Record<string, unknown>, allowedModes?: Modes): Promise<void> {
      const { decision, wait } = readDecision(input);
      const detail = await application.detail(agentId);
      if (allowedModes) requireRemoteAgentMode(detail.agent.definition.toolPermissionMode, allowedModes);
      if (wait && await alreadyDecided(detail, decision, wait, allowedModes)) return;
      const attempt = currentApprovalAttempt(detail);
      const pending = attempt ? await work.listApprovals(attempt.request) : [];
      const matches = pending.some(item => matchesPending(item, decision, wait));
      if (!attempt || !matches) {
        if (pending.some(item => item.request.approvalId === decision.approvalId)) throw new Error("approval_conflict");
        throw new Error("agents_approval_not_found");
      }
      if (allowedModes) requireRemoteAgentMode(attempt.request.toolPermissionMode, allowedModes);
      const result = await work.decideApproval(attempt.request, { ...decision, ...wait });
      if (!result.accepted) throw new Error(result.reason);
    },
  };
}
