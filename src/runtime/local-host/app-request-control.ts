import type { RuntimeRequestOptions } from "../composition.js";
import type { SessionWaitExpectation } from "../../sessions/request-lifecycle/contracts.js";
import { createRequestInterruptionError } from "../request/interruption.js";
import {
  createRequestCancellationError,
  type RequestCancellationResult,
  type SavedWaitCancellation,
} from "../request/cancellation.js";
import type { ToolApprovalController } from "../ports.js";
import {
  createRequestSteeringInbox,
  type RequestSteeringInbox,
  type RequestSteeringUpdate,
} from "../request/request-steering.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { LocalRuntimePeer } from "./contracts.js";
import {
  hasApprovalDecisionIdentity,
  LocalRequestApprovals,
} from "./app-request-approvals.js";
import { LocalRequestDelivery } from "./app-request-delivery.js";
import type {
  LocalPendingToolApproval,
  LocalToolApprovalDecisionResult,
} from "./request-approval-contracts.js";

export type LocalRequestRunOptions = {
  approvalAvailable?: boolean;
  durableApprovals?: boolean;
  steeringUpdates?: readonly RequestSteeringUpdate[];
};

type ActiveRequestControl = {
  resumedWait?: SessionWaitExpectation;
  sessionId: string;
  abort: AbortController;
  finalizing: boolean;
  steering: RequestSteeringInbox;
  run?: SchedulerRun;
  peer?: LocalRuntimePeer;
  delivery: LocalRequestDelivery;
};

export class LocalRequestControls {
  private readonly active = new Map<string, ActiveRequestControl>();
  private readonly controlPeers = new Map<string, LocalRuntimePeer>();
  private readonly pendingApprovals = new LocalRequestApprovals();
  private stopped = false;

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
    sessionId = "",
    resumedWait?: SessionWaitExpectation,
  ): RuntimeRequestOptions {
    const steering = this.open(requestId, sessionId);
    try {
      for (const update of options.steeringUpdates ?? []) {
        const accepted = steering.append(update);
        if (!accepted.ok) throw new Error(accepted.reason);
      }
    } catch (error) {
      this.finish(requestId);
      throw error;
    }
    const control = this.active.get(requestId)!;
    control.resumedWait = resumedWait;
    control.peer = peer;
    control.delivery.attach(peer);
    return {
      abortSignal: control.abort.signal,
      claimFinalization: () => this.claimFinalization(control),
      requestSteering: steering,
      ...(options.approvalAvailable
        ? { toolApprovalController: this.approvals(requestId, control) }
        : {}),
    };
  }

  scheduled(run: SchedulerRun): RuntimeRequestOptions {
    const steering = this.open(run.requestId, run.sessionId, run);
    const control = this.active.get(run.requestId)!;
    this.publish({ type: "scheduled.started", run });
    const peer = this.controlPeers.values().next().value as
      | LocalRuntimePeer
      | undefined;
    return {
      abortSignal: control.abort.signal,
      claimFinalization: () => this.claimFinalization(control),
      requestSteering: steering,
      ...(peer
        ? { toolApprovalController: this.approvals(run.requestId, control) }
        : {}),
    };
  }

  steer(requestId: unknown, update: unknown): unknown {
    if (typeof requestId !== "string")
      return { ok: false, reason: "request_not_active" };
    const control = this.active.get(requestId);
    if (!control || control.abort.signal.aborted)
      return { ok: false, reason: "request_not_active" };
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
    this.pendingApprovals.cancel(requestId);
    entry?.delivery.finish();
    void entry?.steering.close();
  }

  cancel(
    requestId: unknown,
    sessionId: unknown,
    wait?: unknown,
  ): RequestCancellationResult {
    const control =
      typeof requestId === "string" ? this.active.get(requestId) : undefined;
    if (!control) return { accepted: false, reason: "request_not_active" };
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId !== control.sessionId
    )
      return { accepted: false, reason: "session_mismatch" };
    if (control.finalizing)
      return { accepted: false, reason: "request_not_active" };
    if (!this.matchesResumedWaitCancellation(control, wait))
      return { accepted: false, reason: "request_not_active" };
    control.abort.abort(createRequestCancellationError());
    return { accepted: true };
  }

  private matchesResumedWaitCancellation(
    control: ActiveRequestControl,
    input: unknown,
  ): boolean {
    if (input === undefined) return true;
    if (!input || typeof input !== "object") return false;
    const wait = control.resumedWait;
    if (!wait) return false;
    const command = input as Partial<SavedWaitCancellation>;
    if (typeof command.commandId !== "string" || !command.commandId)
      return false;
    if (command.generation !== wait.generation) return false;
    if (command.waitId !== wait.waitId) return false;
    return command.revision === wait.revision;
  }

  private claimFinalization(control: ActiveRequestControl): void {
    // In-flight requests retain this exact control until canonical finalization.
    control.abort.signal.throwIfAborted();
    control.finalizing = true;
  }

  stop(): void {
    this.stopped = true;
    this.controlPeers.clear();
    for (const [requestId, control] of this.active) {
      control.abort.abort(createRequestInterruptionError());
    }
    // Accepted requests retain their controls and inboxes until finalization.
  }

  private open(
    requestId: string,
    sessionId: string,
    run?: SchedulerRun,
  ): RequestSteeringInbox {
    if (this.stopped) throw new Error("local_runtime_owner_stopped");
    if (!requestId || this.active.has(requestId))
      throw new Error("local_runtime_request_already_active");
    const steering = createRequestSteeringInbox({ requestId });
    this.active.set(requestId, {
      steering,
      sessionId,
      abort: new AbortController(),
      finalizing: false,
      delivery: new LocalRequestDelivery(requestId),
      ...(run ? { run } : {}),
    });
    return steering;
  }

  hasActiveRequest(requestId: unknown, sessionId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const control = this.active.get(requestId);
    if (!control) return false;
    return control.sessionId === sessionId;
  }

  listApprovals(sessionId?: unknown): LocalPendingToolApproval[] {
    return this.pendingApprovals.list(sessionId).map((entry) => {
      const run = this.active.get(entry.request.requestId)?.run;
      return { ...entry, ...(run ? { run: structuredClone(run) } : {}) };
    });
  }

  decideApproval(
    input: unknown,
    peer: LocalRuntimePeer,
  ): LocalToolApprovalDecisionResult {
    if (!hasApprovalDecisionIdentity(input))
      return this.pendingApprovals.decide(input);
    const control = this.active.get(input.requestId);
    if (this.requiresApprovalRequestAttachment(control, peer))
      return { accepted: false, reason: "approval_request_not_attached" };
    return this.pendingApprovals.decide(input);
  }

  private requiresApprovalRequestAttachment(
    control: ActiveRequestControl | undefined,
    peer: LocalRuntimePeer,
  ): boolean {
    if (!control) return false;
    if (control.run) return false;
    return control.peer !== peer;
  }

  async attach(
    requestId: unknown,
    sessionId: unknown,
    peer: LocalRuntimePeer,
  ): Promise<void> {
    const control = this.getAttachableRequest(requestId, sessionId);
    this.pendingApprovals.detach(String(requestId));
    control.peer = peer;
    control.delivery.attach(peer);
    // The readiness acknowledgement permits a decision immediately; bind first.
    await peer.callClient("request.accepted", [requestId]);
    if (this.isAttachedApprovalPeer(control, peer))
      this.pendingApprovals.attach(String(requestId), peer);
    await control.delivery.finished;
  }

  send(requestId: string, event: unknown): void {
    this.active.get(requestId)?.delivery.send(event);
  }

  async drain(requestId: string): Promise<void> {
    await this.active.get(requestId)?.delivery.drain();
  }

  private isAttachedApprovalPeer(
    control: ActiveRequestControl,
    peer: LocalRuntimePeer,
  ): boolean {
    return control.peer === peer;
  }

  private getAttachableRequest(
    requestId: unknown,
    sessionId: unknown,
  ): ActiveRequestControl {
    if (typeof requestId !== "string")
      throw new Error("local_runtime_request_not_awaiting_approval");
    const control = this.active.get(requestId);
    if (!control)
      throw new Error("local_runtime_request_not_awaiting_approval");
    if (control.sessionId !== sessionId)
      throw new Error("local_runtime_session_mismatch");
    if (control.run) throw new Error("local_runtime_request_is_scheduled");
    if (!this.pendingApprovals.hasPending(requestId))
      throw new Error("local_runtime_request_not_awaiting_approval");
    return control;
  }

  private approvals(
    requestId: string,
    control: ActiveRequestControl,
  ): ToolApprovalController {
    return {
      requestToolApproval: (request, options) => {
        if (request.requestId !== requestId)
          throw new Error("local_runtime_approval_identity_mismatch");
        if (this.stopped) control.abort.abort(createRequestInterruptionError());
        const signal = options?.abortSignal
          ? AbortSignal.any([control.abort.signal, options.abortSignal])
          : control.abort.signal;
        const peer = control.peer ?? this.controlPeers.values().next().value;
        return this.pendingApprovals.wait(
          control.sessionId,
          peer,
          request,
          signal,
        );
      },
    };
  }
}
