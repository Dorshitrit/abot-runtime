import type {
  RuntimeRequestHandler,
  RuntimeRequestOptions,
} from "../composition.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { ToolApprovalRequest } from "../ports.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";
import type { RequestSteeringAppendResult } from "../request/request-steering.js";

type ClientRequest = {
  run?: SchedulerRun;
  options: RuntimeRequestOptions;
  accept: () => void;
  accepted: Promise<void>;
  send?: (event: Record<string, unknown>) => void;
};

/** Client projections only. The owner validates and commits every steering update. */
export class LocalRuntimeClientRequests {
  private readonly active = new Map<string, ClientRequest>();
  private readonly approvals = new Map<string, AbortController>();
  private readonly listeners = new Set<
    (event: Record<string, unknown>) => void
  >();

  constructor(
    private readonly call: LocalRuntimeCallHandler,
    private readonly scheduledOptions?: (
      run: SchedulerRun,
    ) => RuntimeRequestOptions,
  ) {}

  readonly requests: RuntimeRequestHandler = {
    handle: async (ws, message, options = {}) => {
      const requestId = String(message.requestId ?? "");
      if (this.active.has(requestId))
        throw new Error("local_runtime_request_already_active");
      const state = this.open(requestId, options, (event) =>
        ws.send(JSON.stringify(event)),
      );
      try {
        await this.call("request.run", [
          message,
          {
            approvalAvailable: Boolean(options.toolApprovalController),
            steeringUpdates: options.requestSteering?.snapshot().updates ?? [],
          },
        ]);
      } finally {
        state.accept();
        this.active.delete(requestId);
      }
    },
    steer: async (requestId, input) => {
      await this.active.get(requestId)?.accepted;
      return (await this.call("request.steer", [
        requestId,
        input,
      ])) as RequestSteeringAppendResult;
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
      if (this.active.has(run.requestId)) return;
      const state = this.open(
        run.requestId,
        this.scheduledOptions?.(run) ?? {},
      );
      state.run = run;
      state.accept();
      return;
    }
    if (envelope.type !== "scheduled.event") return;
    const payload = envelope.event as Record<string, unknown>;
    this.publish(payload);
    if (payload.type === "completed" || payload.type === "failed") {
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
      this.active
        .get(String(args[0]))
        ?.send?.(args[1] as Record<string, unknown>);
      return null;
    }
    if (method === "request.approval.cancel") {
      this.approvals.get(String(args[0]))?.abort();
      return null;
    }
    if (method !== "request.approval")
      throw new Error("local_runtime_callback_unknown");
    const request = args[0] as ToolApprovalRequest;
    const approval = this.active.get(request.requestId)?.options
      .toolApprovalController;
    if (!approval)
      return { approved: false, reason: "Tool approval is unavailable." };
    const controller = new AbortController();
    this.approvals.set(request.approvalId, controller);
    try {
      return await approval.requestToolApproval(request, {
        abortSignal: controller.signal,
      });
    } finally {
      this.approvals.delete(request.approvalId);
    }
  }

  close(disconnected = false): void {
    if (disconnected) {
      for (const [requestId, state] of this.active) {
        if (!state.run) continue;
        this.publish({
          type: "failed",
          requestId,
          sessionId: state.run.sessionId,
          environment: state.run.environmentId,
          error: "local_runtime_disconnected_outcome_unknown",
        });
      }
    }
    for (const controller of this.approvals.values()) controller.abort();
    for (const state of this.active.values()) state.accept();
    this.active.clear();
    this.approvals.clear();
    this.listeners.clear();
  }

  private open(
    requestId: string,
    options: RuntimeRequestOptions,
    send?: (event: Record<string, unknown>) => void,
  ): ClientRequest {
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const state = { options, send, accept, accepted };
    this.active.set(requestId, state);
    return state;
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
