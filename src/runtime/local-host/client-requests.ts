import type {
  RuntimeRequestHandler,
  RuntimeRequestOptions,
} from "../composition.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { ToolApprovalRequest } from "../ports.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";
import type { RequestSteeringAppendResult } from "../request/request-steering.js";
import type {
  LocalPendingToolApproval,
  LocalToolApprovalDecisionInput,
  LocalToolApprovalDecisionResult,
} from "./request-approval-contracts.js";
import {
  PendingClientRequest,
  hasLiveApprovalAttachment,
  hasApprovalEndedBeforeAttachment,
  isApprovalTransportLoss,
  shouldRetainDetachedRequest,
} from "./pending-client-request.js";

type ClientApprovalCallback = {
  controller: AbortController;
  requestId: string;
  detached: boolean;
};

/** Client projections only. The owner validates and commits every steering update. */
export class LocalRuntimeClientRequests {
  private readonly active = new Map<string, PendingClientRequest>();
  private readonly approvalCallbacks = new Map<
    string,
    ClientApprovalCallback
  >();
  private readonly listeners = new Set<
    (event: Record<string, unknown>) => void
  >();

  constructor(
    private readonly call: LocalRuntimeCallHandler,
    private readonly scheduledOptions?: (
      run: SchedulerRun,
    ) => RuntimeRequestOptions,
    private readonly approvalCall: LocalRuntimeCallHandler = call,
  ) {}

  readonly requests: RuntimeRequestHandler = {
    cancel: async (requestId, sessionId, wait) => {
      const state = this.active.get(requestId);
      await state?.accepted;
      if (state && shouldRetainDetachedRequest(state))
        await this.restoreCancellationDelivery(requestId, sessionId, state);
      return (await this.call("request.cancel", [
        requestId,
        sessionId,
        ...(wait ? [wait] : []),
      ])) as import("../request/cancellation.js").RequestCancellationResult;
    },
    handle: async (ws, message, options = {}) => {
      const requestId = String(message.requestId ?? "");
      if (this.active.has(requestId))
        throw new Error("local_runtime_request_already_active");
      const state = this.open(
        requestId,
        String(message.sessionId ?? ""),
        options,
        (event) => ws.send(JSON.stringify(event)),
      );
      const cancel = () => {
        void this.requests.cancel!(
          requestId,
          String(message.sessionId ?? ""),
        ).catch(() => {});
      };
      options.abortSignal?.addEventListener("abort", cancel, { once: true });
      if (options.abortSignal?.aborted) cancel();
      let outcome: import("../request/handler.js").RequestHandlerOutcome =
        undefined;
      try {
        outcome = (await this.trackOwnerRequest(state, () =>
          this.call("request.run", [
            message,
            {
              approvalAvailable: Boolean(options.toolApprovalController),
              durableApprovals: options.durableApprovals === true,
              steeringUpdates:
                options.requestSteering?.snapshot().updates ?? [],
            },
          ]),
        )) as import("../request/handler.js").RequestHandlerOutcome;
      } finally {
        options.abortSignal?.removeEventListener("abort", cancel);
        state.releaseAcceptance();
        if (this.active.get(requestId) === state) this.active.delete(requestId);
      }
      return outcome;
    },
    steer: async (requestId, input) => {
      await this.active.get(requestId)?.accepted;
      return (await this.call("request.steer", [
        requestId,
        input,
      ])) as RequestSteeringAppendResult;
    },
  };

  readonly approvals = {
    list: async (sessionId?: string): Promise<LocalPendingToolApproval[]> => {
      const captures = [...this.active.values()].flatMap((state) => {
        const revision = state.captureApprovalSnapshotRevision(sessionId);
        if (revision === undefined) return [];
        return [{ state, revision }];
      });
      const pending = (await this.approvalCall("request.approvals", [
        sessionId,
      ])) as LocalPendingToolApproval[];
      for (const { state, revision } of captures) {
        if (this.active.get(state.requestId) !== state) continue;
        const ownerActive = state.needsOwnerActivityCheck(pending, revision)
          ? ((await this.call("request.active", [
              state.requestId,
              state.sessionId,
            ])) as boolean)
          : undefined;
        if (this.active.get(state.requestId) !== state) continue;
        if (!state.reconcileApprovalSnapshot(pending, revision, ownerActive))
          continue;
        this.publishDisconnectedScheduledRequest(state);
        this.active.delete(state.requestId);
      }
      return pending;
    },
    decide: async (
      input: LocalToolApprovalDecisionInput,
    ): Promise<LocalToolApprovalDecisionResult> => {
      const state = this.active.get(input.requestId);
      if (state && shouldRetainDetachedRequest(state))
        await this.restoreApprovalDelivery(
          input.requestId,
          input.sessionId,
          state,
        );
      // Once delivery is bound, a new loss must fail this decision attempt.
      const decide = state ? this.call : this.approvalCall;
      return (await decide("request.approval.decide", [
        input,
      ])) as LocalToolApprovalDecisionResult;
    },
    attach: async (
      requestId: string,
      sessionId: string,
      ws: Parameters<RuntimeRequestHandler["handle"]>[0],
      options: RuntimeRequestOptions = {},
      onAccepted?: () => void,
    ): Promise<void> => {
      const send = (event: Record<string, unknown>) =>
        ws.send(JSON.stringify(event));
      return this.attachRequest(
        requestId,
        sessionId,
        options,
        send,
        onAccepted,
      );
    },
  };

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  receive(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const envelope = event as Record<string, unknown>;
    if (envelope.type === "scheduled.started") {
      const run = envelope.run as SchedulerRun;
      const existing = this.active.get(run.requestId);
      if (existing) {
        existing.detached = false;
        return;
      }
      const state = this.open(
        run.requestId,
        run.sessionId,
        this.scheduledOptions?.(run) ?? {},
      );
      state.run = run;
      state.accept();
      return;
    }
    if (envelope.type === "request.event") {
      this.publish(envelope.event as Record<string, unknown>);
      return;
    }
    if (envelope.type !== "scheduled.event") return;
    const payload = envelope.event as Record<string, unknown>;
    this.active.get(String(payload.requestId))?.observeApproval(payload);
    this.publish(payload);
    if (payload.type === "completed" || payload.type === "failed") {
      this.active.get(String(payload.requestId))?.settle();
      this.active.delete(String(payload.requestId));
    }
  }

  async handleCallback(
    method: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    if (method === "scheduled.started") {
      this.receive({ type: "scheduled.started", run: args[0] });
      return null;
    }
    if (method === "request.accepted") {
      this.active.get(String(args[0]))?.accept();
      return null;
    }
    if (method === "request.event") {
      const state = this.active.get(String(args[0]));
      const event = args[1] as Record<string, unknown>;
      state?.observeApproval(event);
      state?.send?.(event);
      return null;
    }
    if (method === "request.approval.cancel") {
      this.approvalCallbacks.get(String(args[0]))?.controller.abort();
      return null;
    }
    if (method !== "request.approval")
      throw new Error("local_runtime_callback_unknown");
    const request = args[0] as ToolApprovalRequest;
    const state = this.active.get(request.requestId);
    const approval = state?.options.toolApprovalController;
    if (!approval) {
      if (state) state.callbackUnavailable = true;
      throw new Error("local_runtime_tool_approval_view_unavailable");
    }
    state!.callbackUnavailable = false;
    const controller = new AbortController();
    const callback = {
      controller,
      requestId: request.requestId,
      detached: false,
    };
    this.approvalCallbacks.set(request.approvalId, callback);
    state?.observeApprovalCallback(request.approvalId);
    try {
      return await approval.requestToolApproval(request, {
        abortSignal: controller.signal,
      });
    } catch (error) {
      state!.callbackUnavailable = true;
      throw error;
    } finally {
      if (this.approvalCallbacks.get(request.approvalId) === callback)
        this.approvalCallbacks.delete(request.approvalId);
    }
  }

  close(disconnected = false): void {
    if (disconnected) {
      for (const state of this.active.values()) {
        state.markDisconnected();
        if (shouldRetainDetachedRequest(state)) continue;
        this.publishDisconnectedScheduledRequest(state);
      }
    }
    for (const callback of this.approvalCallbacks.values()) {
      callback.detached = disconnected;
      callback.controller.abort();
    }
    this.approvalCallbacks.clear();
    for (const [requestId, state] of this.active) {
      state.releaseAcceptance();
      if (disconnected && shouldRetainDetachedRequest(state)) continue;
      state.settle(
        new Error(
          disconnected
            ? "local_runtime_connection_lost"
            : "local_runtime_stopped",
        ),
      );
      this.active.delete(requestId);
    }
    if (!disconnected) this.listeners.clear();
  }

  private open(
    requestId: string,
    sessionId: string,
    options: RuntimeRequestOptions,
    send?: (event: Record<string, unknown>) => void,
  ): PendingClientRequest {
    const state = new PendingClientRequest(requestId, sessionId, options, send);
    this.active.set(requestId, state);
    return state;
  }

  private async restoreCancellationDelivery(
    requestId: string,
    sessionId: string,
    state: PendingClientRequest,
  ): Promise<void> {
    try {
      await this.restoreApprovalDelivery(requestId, sessionId, state);
    } catch (error) {
      if (!hasApprovalEndedBeforeAttachment(error)) throw error;
    }
  }

  private restoreApprovalDelivery(
    requestId: string,
    sessionId: string,
    state: PendingClientRequest,
  ): Promise<void> {
    // Scheduled delivery uses owner broadcasts and controls registration.
    if (state.run)
      return this.approvalCall("request.approvals", [sessionId]).then(() => {});
    return new Promise((resolve, reject) => {
      void this.attachRequest(
        requestId,
        sessionId,
        state.options,
        state.send,
        resolve,
      ).catch(reject);
    });
  }

  private async attachRequest(
    requestId: string,
    sessionId: string,
    options: RuntimeRequestOptions,
    send?: (event: Record<string, unknown>) => void,
    onAccepted?: () => void,
  ): Promise<void> {
    const existing = this.active.get(requestId);
    if (existing && hasLiveApprovalAttachment(existing)) {
      await existing.accepted;
      onAccepted?.();
      return existing.waitForCompletion();
    }
    const state = existing ?? this.open(requestId, sessionId, options, send);
    state.options = options;
    state.send = send;
    state.prepareAttachment(onAccepted);
    try {
      await this.trackOwnerRequest(
        state,
        () => this.approvalCall("request.attach", [requestId, sessionId]),
        false,
      );
    } finally {
      state.releaseAcceptance();
      if (!shouldRetainDetachedRequest(state)) this.active.delete(requestId);
    }
  }

  private async trackOwnerRequest(
    state: PendingClientRequest,
    invoke: () => Promise<unknown>,
    retainOriginalWait = true,
  ): Promise<unknown> {
    let outcome: unknown;
    try {
      outcome = await invoke();
      state.settle();
    } catch (error) {
      if (!isApprovalTransportLoss(state, error)) state.settle(error);
      if (!retainOriginalWait) throw error;
    }
    await state.waitForCompletion();
    return outcome;
  }

  private publishDisconnectedScheduledRequest(
    state: PendingClientRequest,
  ): void {
    if (!state.run) return;
    this.publish({
      type: "failed",
      requestId: state.requestId,
      sessionId: state.run.sessionId,
      environment: state.run.environmentId,
      error: "local_runtime_disconnected_outcome_unknown",
    });
  }

  private publish(event: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A client view cannot prevent request or approval cleanup.
      }
    }
  }
}
