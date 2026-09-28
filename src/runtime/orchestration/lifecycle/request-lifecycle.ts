import { traceDebug } from "../../observability/debug-logger.js";
import { createRequestCancellationError } from "../../request/cancellation.js";
import { isRequestInterruption } from "../../request/interruption.js";
import {
  assertExecutionBudgets,
  type RequestExecutionBudgets,
} from "./execution-budgets.js";

export type RequestLifecycleAbortReason =
  | "request_timeout"
  | "request_inactivity_timeout";

export type MeaningfulProgressKind =
  | "accepted_tool_execution"
  | "valid_decision"
  | "valid_final_output";

export type RequestLifecycleState = {
  stage?: string;
  phase?: string;
  message?: string;
  reason?: string;
  attempt?: number;
  toolIteration?: number;
  decisionAttemptCount?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 0;
const DEFAULT_REQUEST_INACTIVITY_TIMEOUT_MS = 0;

function readPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function getRequestTimeoutMs(): number {
  return readPositiveInt(
    "LLM_RUNTIME_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
}

export function getRequestInactivityTimeoutMs(): number {
  return readPositiveInt(
    "LLM_RUNTIME_REQUEST_INACTIVITY_TIMEOUT_MS",
    DEFAULT_REQUEST_INACTIVITY_TIMEOUT_MS,
  );
}

export class RequestLifecycle {
  readonly abortController = new AbortController();

  private readonly requestId: string;

  private readonly startedAtMs: number;

  private readonly requestTimeoutMs: number;

  private readonly inactivityTimeoutMs: number;

  private requestTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  private inactivityTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  private requestTimeoutRemainingMs: number;
  private inactivityTimeoutRemainingMs: number;
  private requestTimeoutDeadlineMs: number | undefined;
  private inactivityTimeoutDeadlineMs: number | undefined;
  private pendingApprovalWaits = 0;
  private disposed = false;

  private abortReason: RequestLifecycleAbortReason | null = null;

  private state: RequestLifecycleState = {};
  private readonly removeExternalAbort: () => void;

  constructor(params: {
    requestId: string;
    requestTimeoutMs?: number;
    inactivityTimeoutMs?: number;
    abortSignal?: AbortSignal;
    budgets?: RequestExecutionBudgets;
  }) {
    this.requestId = params.requestId;
    this.startedAtMs = Date.now();
    if (params.budgets) assertExecutionBudgets(params.budgets);
    this.requestTimeoutMs =
      params.budgets?.requestTimeoutMs ??
      params.requestTimeoutMs ??
      getRequestTimeoutMs();
    this.inactivityTimeoutMs =
      params.budgets?.inactivityTimeoutMs ??
      params.inactivityTimeoutMs ??
      getRequestInactivityTimeoutMs();
    this.requestTimeoutRemainingMs =
      params.budgets?.requestRemainingMs ?? this.requestTimeoutMs;
    this.inactivityTimeoutRemainingMs =
      params.budgets?.inactivityRemainingMs ?? this.inactivityTimeoutMs;

    this.scheduleRequestTimeout();
    this.scheduleInactivityTimeout();
    const external = params.abortSignal;
    const abort = () => {
      const reason = isRequestInterruption(external?.reason)
        ? external.reason
        : createRequestCancellationError();
      this.abortController.abort(reason);
    };
    external?.addEventListener("abort", abort, { once: true });
    this.removeExternalAbort = () =>
      external?.removeEventListener("abort", abort);
    if (external?.aborted) abort();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get timedOutReason(): RequestLifecycleAbortReason | null {
    return this.abortReason;
  }

  snapshotBudgets(): RequestExecutionBudgets {
    const now = Date.now();
    return {
      requestTimeoutMs: this.requestTimeoutMs,
      inactivityTimeoutMs: this.inactivityTimeoutMs,
      requestRemainingMs:
        this.requestTimeoutDeadlineMs === undefined
          ? this.requestTimeoutRemainingMs
          : Math.max(0, this.requestTimeoutDeadlineMs - now),
      inactivityRemainingMs:
        this.inactivityTimeoutDeadlineMs === undefined
          ? this.inactivityTimeoutRemainingMs
          : Math.max(0, this.inactivityTimeoutDeadlineMs - now),
    };
  }

  /** Human decision time does not consume either request execution budget. */
  beginToolApprovalWait(): () => void {
    if (!this.hasPendingToolApprovals()) this.suspendTimeouts();
    this.pendingApprovalWaits += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingApprovalWaits -= 1;
      this.scheduleRequestTimeout();
      this.scheduleInactivityTimeout();
    };
  }

  markProgress(kind: MeaningfulProgressKind): void {
    if (this.abortReason !== null || this.signal.aborted) {
      return;
    }
    traceDebug("runtime.request.lifecycle", "request.progress", {
      requestId: this.requestId,
      kind,
    });
    this.resetInactivityTimer();
  }

  updateState(state: RequestLifecycleState): void {
    this.state = {
      ...this.state,
      ...state,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.removeExternalAbort();
    this.clearTimeouts();
  }

  private hasPendingToolApprovals(): boolean {
    return this.pendingApprovalWaits > 0;
  }

  private canScheduleTimeouts(): boolean {
    if (this.disposed) return false;
    if (this.signal.aborted) return false;
    return !this.hasPendingToolApprovals();
  }

  private suspendTimeouts(): void {
    const now = Date.now();
    if (this.requestTimeoutDeadlineMs !== undefined) {
      this.requestTimeoutRemainingMs = Math.max(
        0,
        this.requestTimeoutDeadlineMs - now,
      );
    }
    if (this.inactivityTimeoutDeadlineMs !== undefined) {
      this.inactivityTimeoutRemainingMs = Math.max(
        0,
        this.inactivityTimeoutDeadlineMs - now,
      );
    }
    this.clearTimeouts();
  }

  private clearTimeouts(): void {
    if (this.requestTimeoutHandle !== undefined) {
      clearTimeout(this.requestTimeoutHandle);
      this.requestTimeoutHandle = undefined;
    }
    if (this.inactivityTimeoutHandle !== undefined) {
      clearTimeout(this.inactivityTimeoutHandle);
      this.inactivityTimeoutHandle = undefined;
    }
    this.requestTimeoutDeadlineMs = undefined;
    this.inactivityTimeoutDeadlineMs = undefined;
  }

  private scheduleRequestTimeout(): void {
    if (!this.canScheduleRequestTimeout()) return;
    this.requestTimeoutDeadlineMs = Date.now() + this.requestTimeoutRemainingMs;
    this.requestTimeoutHandle = setTimeout(() => {
      this.abort("request_timeout");
    }, this.requestTimeoutRemainingMs);
  }

  private scheduleInactivityTimeout(): void {
    if (!this.canScheduleInactivityTimeout()) return;
    this.inactivityTimeoutDeadlineMs =
      Date.now() + this.inactivityTimeoutRemainingMs;
    this.inactivityTimeoutHandle = setTimeout(() => {
      this.abort("request_inactivity_timeout");
    }, this.inactivityTimeoutRemainingMs);
  }

  private canScheduleRequestTimeout(): boolean {
    if (this.requestTimeoutMs <= 0) return false;
    return this.canScheduleTimeouts();
  }

  private canScheduleInactivityTimeout(): boolean {
    if (this.inactivityTimeoutMs <= 0) return false;
    return this.canScheduleTimeouts();
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimeoutHandle !== undefined) {
      clearTimeout(this.inactivityTimeoutHandle);
      this.inactivityTimeoutHandle = undefined;
    }
    this.inactivityTimeoutDeadlineMs = undefined;
    this.inactivityTimeoutRemainingMs = this.inactivityTimeoutMs;
    this.scheduleInactivityTimeout();
  }

  private abort(reason: RequestLifecycleAbortReason): void {
    if (this.abortReason !== null) {
      return;
    }
    this.abortReason = reason;
    traceDebug("runtime.request.lifecycle", "request.timeout", {
      requestId: this.requestId,
      reason,
      elapsedMs: Date.now() - this.startedAtMs,
      stage: this.state.stage ?? "",
      phase: this.state.phase ?? "",
      toolIteration:
        typeof this.state.toolIteration === "number"
          ? this.state.toolIteration
          : null,
      decisionAttemptCount:
        typeof this.state.decisionAttemptCount === "number"
          ? this.state.decisionAttemptCount
          : null,
      requestTimeoutMs: this.requestTimeoutMs,
      inactivityTimeoutMs: this.inactivityTimeoutMs,
    });
    this.abortController.abort(new Error(reason));
    this.dispose();
  }
}

export function buildLifecycleDegradedOutput(
  reason: RequestLifecycleAbortReason,
): string {
  return reason === "request_inactivity_timeout"
    ? "Unable to complete the request before the inactivity timeout."
    : "Unable to complete the request before the request timeout.";
}
