import type { RuntimeRequestOptions } from "../composition.js";
import type {
  ToolApprovalController,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../ports.js";
import {
  createRequestSteeringInbox,
  type RequestSteeringInbox,
  type RequestSteeringUpdate,
} from "../request/request-steering.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { LocalRuntimePeer } from "./contracts.js";

export type LocalRequestRunOptions = {
  approvalAvailable?: boolean;
  steeringUpdates?: readonly RequestSteeringUpdate[];
};

type ActiveRequestControl = {
  steering: RequestSteeringInbox;
  run?: SchedulerRun;
};

function readApprovalDecision(value: unknown): ToolApprovalDecision {
  if (typeof value !== "object" || value === null)
    return { approved: false, reason: "Tool approval response was invalid." };
  const decision = value as Partial<ToolApprovalDecision>;
  return {
    approved: decision.approved === true,
    ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
  };
}

export class LocalRequestControls {
  private readonly active = new Map<string, ActiveRequestControl>();
  private readonly controlPeers = new Map<string, LocalRuntimePeer>();
  private readonly pendingApprovals = new Set<() => void>();

  constructor(private readonly publish: (event: unknown) => void) {}

  async register(peer: LocalRuntimePeer): Promise<void> {
    if (!this.controlPeers.has(peer.id)) {
      this.controlPeers.set(peer.id, peer);
      peer.onClose(() => this.controlPeers.delete(peer.id));
    }
    const runs = [...this.active.values()].flatMap((entry) =>
      entry.run ? [entry.run] : [],
    );
    // Queue snapshots on the same ordered channel as subsequent run events.
    await Promise.all(
      runs.map((run) => peer.callClient("scheduled.started", [run])),
    );
  }

  ordinary(
    requestId: string,
    peer: LocalRuntimePeer,
    options: LocalRequestRunOptions,
  ): RuntimeRequestOptions {
    const steering = this.open(requestId);
    try {
      for (const update of options.steeringUpdates ?? []) {
        const accepted = steering.append(update);
        if (!accepted.ok) throw new Error(accepted.reason);
      }
    } catch (error) {
      this.finish(requestId);
      throw error;
    }
    return {
      requestSteering: steering,
      ...(options.approvalAvailable
        ? { toolApprovalController: this.approvals(peer) }
        : {}),
    };
  }

  scheduled(run: SchedulerRun): RuntimeRequestOptions {
    const steering = this.open(run.requestId, run);
    this.publish({ type: "scheduled.started", run });
    const peer = this.controlPeers.values().next().value as
      | LocalRuntimePeer
      | undefined;
    return {
      requestSteering: steering,
      ...(peer ? { toolApprovalController: this.approvals(peer) } : {}),
    };
  }

  steer(requestId: unknown, update: unknown): unknown {
    if (typeof requestId !== "string")
      return { ok: false, reason: "request_not_active" };
    const control = this.active.get(requestId);
    if (!control) return { ok: false, reason: "request_not_active" };
    if (!update || typeof update !== "object")
      return { ok: false, reason: "invalid_steer_request" };
    const input = update as { steerId?: unknown; text?: unknown };
    if (typeof input.steerId !== "string" || typeof input.text !== "string")
      return { ok: false, reason: "invalid_steer_request" };
    return control.steering.append({
      steerId: input.steerId,
      text: input.text,
    });
  }

  finish(requestId: string): void {
    const entry = this.active.get(requestId);
    this.active.delete(requestId);
    void entry?.steering.close();
  }

  stop(): void {
    this.controlPeers.clear();
    for (const cancel of this.pendingApprovals) cancel();
    // Active canonical requests own their inbox lifetime until finalization.
    this.active.clear();
  }

  private open(requestId: string, run?: SchedulerRun): RequestSteeringInbox {
    if (!requestId || this.active.has(requestId))
      throw new Error("local_runtime_request_already_active");
    const steering = createRequestSteeringInbox({ requestId });
    this.active.set(requestId, { steering, ...(run ? { run } : {}) });
    return steering;
  }

  private approvals(peer: LocalRuntimePeer): ToolApprovalController {
    return {
      requestToolApproval: (request, options) =>
        this.requestApproval(peer, request, options?.abortSignal),
    };
  }

  private requestApproval(
    peer: LocalRuntimePeer,
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    if (signal?.aborted)
      return Promise.resolve({
        approved: false,
        reason: "Tool approval was cancelled.",
      });
    return new Promise((resolve) => {
      let settled = false;
      let removeClose = () => {};
      const complete = (decision: ToolApprovalDecision) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        this.pendingApprovals.delete(cancel);
        removeClose();
        resolve(decision);
      };
      const cancel = () => {
        void peer
          .callClient("request.approval.cancel", [request.approvalId])
          .catch(() => undefined);
        complete({ approved: false, reason: "Tool approval was cancelled." });
      };
      this.pendingApprovals.add(cancel);
      removeClose = peer.onClose(() =>
        complete({
          approved: false,
          reason: "Tool approval connection was closed.",
        }),
      );
      if (settled) return;
      signal?.addEventListener("abort", cancel, { once: true });
      void peer.callClient("request.approval", [request]).then(
        (decision) => complete(readApprovalDecision(decision)),
        () =>
          complete({
            approved: false,
            reason: "Tool approval connection was closed.",
          }),
      );
    });
  }
}
