import type {
  ToolApprovalController,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../../runtime/ports.js";
import type { ActiveRequest, JsonObject } from "./contracts.js";
import { getString } from "./http.js";

type PendingApproval = {
  requestId: string;
  resolve(decision: ToolApprovalDecision): void;
};

export type PendingWebToolApproval = {
  environmentId: string;
  sessionId: string;
  requestId: string;
  approvalId: string;
  event: JsonObject;
  generation?: string;
  waitId?: string;
  revision?: number;
};

export type WebToolApprovalDecision = Omit<PendingWebToolApproval, "event"> &
  ToolApprovalDecision & { commandId?: string };

function isRequiredApprovalEvent(
  event: JsonObject,
  requestId: string,
  approvalId: string,
): boolean {
  if (event.name !== "tool.approval.required") return false;
  if (event.approvalId !== approvalId) return false;
  return event.requestId === requestId;
}

function findRequiredApprovalEvent(active: ActiveRequest, approvalId: string) {
  return active.events.find((event) =>
    isRequiredApprovalEvent(event, active.requestId, approvalId),
  );
}

function isLiveApprovalRequest(
  active: ActiveRequest | undefined,
  environmentId: string,
): active is ActiveRequest {
  if (!active || active.finalState) return false;
  return active.environmentId === environmentId;
}

function canResolvePendingApproval(
  pending: PendingApproval | undefined,
  active: ActiveRequest | undefined,
  decision: WebToolApprovalDecision,
): pending is PendingApproval {
  if (!pending || pending.requestId !== decision.requestId) return false;
  if (!isLiveApprovalRequest(active, decision.environmentId)) return false;
  if (active.sessionId !== decision.sessionId) return false;
  return Boolean(findRequiredApprovalEvent(active, decision.approvalId));
}

/** Own the transport's existing live promises; persisted events are never authority. */
export class PendingToolApprovals implements ToolApprovalController {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly activeRequest: (id: string) => ActiveRequest | undefined,
    private readonly onChanged?: (requestId: string) => void,
  ) {}

  requestToolApproval(
    request: ToolApprovalRequest,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ToolApprovalDecision> {
    return new Promise((resolve) => {
      if (options?.abortSignal?.aborted) {
        resolve({ approved: false, reason: "Tool approval was cancelled." });
        return;
      }
      const complete = (decision: ToolApprovalDecision) => {
        const removed = this.pending.delete(request.approvalId);
        options?.abortSignal?.removeEventListener("abort", onAbort);
        resolve(decision);
        if (removed) this.notifyChanged(request.requestId);
      };
      const onAbort = () =>
        complete({ approved: false, reason: "Tool approval was cancelled." });
      options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.approvalId, {
        requestId: request.requestId,
        resolve: complete,
      });
      this.notifyChanged(request.requestId);
    });
  }

  private notifyChanged(requestId: string): void {
    try {
      this.onChanged?.(requestId);
    } catch {
      // Client refresh failures cannot change a pending approval decision.
    }
  }

  list(environmentId: string): PendingWebToolApproval[] {
    const approvals: PendingWebToolApproval[] = [];
    for (const [approvalId, pending] of this.pending) {
      const active = this.activeRequest(pending.requestId);
      if (!isLiveApprovalRequest(active, environmentId)) continue;
      const event = findRequiredApprovalEvent(active, approvalId);
      if (!event) continue;
      approvals.push({
        environmentId,
        sessionId: active.sessionId,
        requestId: active.requestId,
        approvalId,
        event,
      });
    }
    return approvals;
  }

  decide(decision: WebToolApprovalDecision): boolean {
    const pending = this.pending.get(decision.approvalId);
    const active = this.activeRequest(decision.requestId);
    if (!canResolvePendingApproval(pending, active, decision)) return false;
    pending.resolve({ approved: decision.approved });
    return true;
  }

  resolveRealtime(message: JsonObject): void {
    const approvalId = getString(message.approvalId);
    if (!approvalId) return;
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    pending.resolve({
      approved: message.approved === true,
      reason: getString(message.reason).trim() || undefined,
    });
  }
}
