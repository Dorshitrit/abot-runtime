import type { ToolApprovalDecision, ToolApprovalRequest } from "../ports.js";
import type { LocalRuntimePeer } from "./contracts.js";
import type {
  LocalPendingToolApproval,
  LocalToolApprovalDecisionInput,
  LocalToolApprovalDecisionResult,
} from "./request-approval-contracts.js";

type ApprovalOffer = {
  peer: LocalRuntimePeer;
  connected: boolean;
  removeClose: () => void;
};

type PendingApproval = {
  sessionId: string;
  request: ToolApprovalRequest;
  complete: (decision: ToolApprovalDecision, notify?: boolean) => void;
  abort: (reason: unknown) => void;
  offer?: ApprovalOffer;
};

export function hasApprovalDecisionIdentity(
  input: unknown,
): input is LocalToolApprovalDecisionInput {
  if (!input || typeof input !== "object") return false;
  const value = input as Partial<LocalToolApprovalDecisionInput>;
  if (typeof value.sessionId !== "string") return false;
  if (typeof value.requestId !== "string") return false;
  if (typeof value.approvalId !== "string") return false;
  if (typeof value.approved !== "boolean") return false;
  return value.reason === undefined || typeof value.reason === "string";
}

function readCallbackDecision(value: unknown): ToolApprovalDecision {
  if (typeof value !== "object" || value === null)
    return { approved: false, reason: "Tool approval response was invalid." };
  const decision = value as Partial<ToolApprovalDecision>;
  return {
    approved: decision.approved === true,
    ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
  };
}

/** Approval promises belong to the live request, never to a transport attempt. */
export class LocalRequestApprovals {
  private readonly pending = new Map<string, Map<string, PendingApproval>>();

  list(sessionId?: unknown): LocalPendingToolApproval[] {
    const entries = [...this.pending.values()].flatMap((group) => [
      ...group.values(),
    ]);
    return entries
      .filter(
        (entry) => sessionId === undefined || entry.sessionId === sessionId,
      )
      .map((entry) => ({
        sessionId: entry.sessionId,
        request: structuredClone(entry.request),
      }));
  }

  hasPending(requestId: string): boolean {
    return Boolean(this.pending.get(requestId)?.size);
  }

  decide(input: unknown): LocalToolApprovalDecisionResult {
    if (!hasApprovalDecisionIdentity(input))
      return { accepted: false, reason: "invalid_approval_decision" };
    const entry = this.pending.get(input.requestId)?.get(input.approvalId);
    if (!entry) return { accepted: false, reason: "approval_not_pending" };
    if (entry.sessionId !== input.sessionId)
      return { accepted: false, reason: "approval_identity_mismatch" };
    entry.complete({
      approved: input.approved,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    return { accepted: true };
  }

  wait(
    sessionId: string,
    peer: LocalRuntimePeer | undefined,
    request: ToolApprovalRequest,
    signal: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const snapshot = structuredClone(request);
    const { requestId, approvalId } = snapshot;
    const group =
      this.pending.get(requestId) ?? new Map<string, PendingApproval>();
    if (group.has(approvalId))
      throw new Error("local_runtime_approval_already_pending");
    return new Promise((resolve, reject) => {
      const release = (entry: PendingApproval, notify = true) => {
        if (group.get(approvalId) !== entry) return false;
        group.delete(approvalId);
        if (!group.size) this.pending.delete(requestId);
        signal.removeEventListener("abort", cancel);
        this.detachOffer(entry, notify);
        return true;
      };
      const entry: PendingApproval = {
        sessionId,
        request: snapshot,
        complete: (decision, notify = true) => {
          if (release(entry, notify)) resolve(decision);
        },
        abort: (reason) => {
          if (release(entry)) reject(reason);
        },
      };
      const cancel = () => entry.abort(signal.reason);
      group.set(approvalId, entry);
      this.pending.set(requestId, group);
      signal.addEventListener("abort", cancel, { once: true });
      if (peer) this.offer(entry, peer);
    });
  }

  detach(requestId: string): void {
    for (const entry of this.pending.get(requestId)?.values() ?? [])
      this.detachOffer(entry);
  }

  attach(requestId: string, peer: LocalRuntimePeer): void {
    for (const entry of this.pending.get(requestId)?.values() ?? [])
      this.offer(entry, peer);
  }

  cancel(requestId: string): void {
    for (const entry of this.pending.get(requestId)?.values() ?? [])
      entry.abort(new Error("request_activation_retired"));
  }

  private offer(entry: PendingApproval, peer: LocalRuntimePeer): void {
    this.detachOffer(entry);
    const offer: ApprovalOffer = {
      peer,
      connected: true,
      removeClose: () => {},
    };
    entry.offer = offer;
    offer.removeClose = peer.onClose(() => {
      offer.connected = false;
    });
    if (!offer.connected) return;
    void peer
      .callClient("request.approval", [structuredClone(entry.request)])
      .then(
        (decision) => {
          if (!this.isCurrentOffer(entry, offer)) return;
          entry.complete(readCallbackDecision(decision), false);
        },
        () => {
          // Delivery failure leaves the same canonical approval unresolved.
          offer.connected = false;
        },
      );
  }

  private isCurrentOffer(
    entry: PendingApproval,
    offer: ApprovalOffer,
  ): boolean {
    if (entry.offer !== offer) return false;
    return offer.connected;
  }

  private detachOffer(entry: PendingApproval, notify = true): void {
    const offer = entry.offer;
    entry.offer = undefined;
    if (!offer) return;
    offer.removeClose();
    if (!offer.connected) return;
    offer.connected = false;
    if (!notify) return;
    void offer.peer
      .callClient("request.approval.cancel", [entry.request.approvalId])
      .catch(() => undefined);
  }
}
