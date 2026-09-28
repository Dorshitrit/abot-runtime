import type { RuntimeRequestOptions } from "../composition.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { LocalPendingToolApproval } from "./request-approval-contracts.js";

/** One client view of an owner request; detachment never settles owner work. */
export class PendingClientRequest {
  run?: SchedulerRun;
  detached = false;
  callbackUnavailable = false;
  awaitingApprovalAttachment = false;
  private approvalStateUnconfirmed = false;
  private approvalObservationRevision = 0;
  readonly approvalIds = new Set<string>();
  accepted!: Promise<void>;
  accept!: () => void;
  releaseAcceptance!: () => void;
  private finish!: (result: { error?: unknown }) => void;
  private readonly completion = new Promise<{ error?: unknown }>((resolve) => {
    this.finish = resolve;
  });

  constructor(
    readonly requestId: string,
    readonly sessionId: string,
    public options: RuntimeRequestOptions,
    public send?: (event: Record<string, unknown>) => void,
  ) {
    this.resetAcceptance();
  }

  resetAcceptance(onAccepted?: () => void): void {
    this.accepted = new Promise<void>((resolve) => {
      this.releaseAcceptance = resolve;
      this.accept = () => {
        resolve();
        onAccepted?.();
        onAccepted = undefined;
      };
    });
  }

  settle(error?: unknown): void {
    this.finish({ error });
  }

  markDisconnected(): void {
    this.detached = true;
    this.approvalStateUnconfirmed = Boolean(
      this.options.toolApprovalController,
    );
    this.approvalObservationRevision += 1;
  }

  prepareAttachment(onAccepted?: () => void): void {
    this.detached = false;
    this.callbackUnavailable = false;
    this.awaitingApprovalAttachment = true;
    this.approvalStateUnconfirmed = false;
    this.approvalObservationRevision += 1;
    this.resetAcceptance(onAccepted);
  }

  observeApprovalCallback(approvalId: string): void {
    this.approvalIds.add(approvalId);
    this.awaitingApprovalAttachment = false;
    this.approvalStateUnconfirmed = false;
    this.approvalObservationRevision += 1;
  }

  captureApprovalSnapshotRevision(sessionId?: string): number | undefined {
    if (!shouldRetainDetachedRequest(this)) return undefined;
    if (sessionId !== undefined && sessionId !== this.sessionId)
      return undefined;
    return this.approvalObservationRevision;
  }

  reconcileApprovalSnapshot(
    pending: readonly LocalPendingToolApproval[],
    capturedRevision: number,
    ownerActive?: boolean,
  ): boolean {
    if (!this.canApplyOwnerSnapshot(capturedRevision)) return false;
    const matching = pending.filter((entry) =>
      this.matchesApprovalIdentity(entry),
    );
    this.approvalIds.clear();
    this.approvalStateUnconfirmed = matching.length === 0;
    this.awaitingApprovalAttachment = false;
    this.approvalObservationRevision += 1;
    for (const entry of matching)
      this.approvalIds.add(entry.request.approvalId);
    if (matching.length > 0) return false;
    if (ownerActive !== false) return false;
    this.settle(new Error("local_runtime_connection_lost"));
    return true;
  }

  needsOwnerActivityCheck(
    pending: readonly LocalPendingToolApproval[],
    capturedRevision: number,
  ): boolean {
    if (!this.canApplyOwnerSnapshot(capturedRevision)) return false;
    return !pending.some((entry) => this.matchesApprovalIdentity(entry));
  }

  private canApplyOwnerSnapshot(capturedRevision: number): boolean {
    if (!shouldRetainDetachedRequest(this)) return false;
    return capturedRevision === this.approvalObservationRevision;
  }

  private matchesApprovalIdentity(entry: LocalPendingToolApproval): boolean {
    if (entry.sessionId !== this.sessionId) return false;
    return entry.request.requestId === this.requestId;
  }

  hasUnconfirmedApproval(): boolean {
    return this.approvalStateUnconfirmed;
  }

  observeApproval(event: Record<string, unknown>): void {
    const approvalId = String(event.approvalId ?? "");
    if (!approvalId) return;
    if (event.name === "tool.approval.required") {
      this.observeApprovalCallback(approvalId);
      return;
    }
    if (event.name === "tool.approval.granted") {
      this.approvalObservationRevision += 1;
      this.approvalIds.delete(approvalId);
      this.awaitingApprovalAttachment = false;
    }
    if (event.name === "tool.approval.rejected") {
      this.approvalObservationRevision += 1;
      this.approvalIds.delete(approvalId);
      this.awaitingApprovalAttachment = false;
    }
  }

  async waitForCompletion(): Promise<void> {
    const result = await this.completion;
    if (result.error !== undefined) throw result.error;
  }
}

export function shouldRetainDetachedRequest(
  state: PendingClientRequest,
): boolean {
  if (!state.detached) return false;
  if (state.hasUnconfirmedApproval()) return true;
  if (state.awaitingApprovalAttachment) return true;
  return state.approvalIds.size > 0;
}

export function isApprovalTransportLoss(
  state: PendingClientRequest,
  error: unknown,
): boolean {
  if (!shouldRetainDetachedRequest(state)) return false;
  if (!(error instanceof Error)) return false;
  return error.message === "local_runtime_connection_lost";
}

export function hasLiveApprovalAttachment(
  state: PendingClientRequest,
): boolean {
  if (state.detached) return false;
  return !state.callbackUnavailable;
}

export function hasApprovalEndedBeforeAttachment(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "local_runtime_request_not_awaiting_approval";
}
