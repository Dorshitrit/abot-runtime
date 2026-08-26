import { traceDebug } from "../../observability/debug-logger.js";

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

  private abortReason: RequestLifecycleAbortReason | null = null;

  private state: RequestLifecycleState = {};

  constructor(params: {
    requestId: string;
    requestTimeoutMs?: number;
    inactivityTimeoutMs?: number;
  }) {
    this.requestId = params.requestId;
    this.startedAtMs = Date.now();
    this.requestTimeoutMs = params.requestTimeoutMs ?? getRequestTimeoutMs();
    this.inactivityTimeoutMs =
      params.inactivityTimeoutMs ?? getRequestInactivityTimeoutMs();

    if (this.requestTimeoutMs > 0) {
      this.requestTimeoutHandle = setTimeout(() => {
        this.abort("request_timeout");
      }, this.requestTimeoutMs);
    }
    this.resetInactivityTimer();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get timedOutReason(): RequestLifecycleAbortReason | null {
    return this.abortReason;
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
    if (this.requestTimeoutHandle !== undefined) {
      clearTimeout(this.requestTimeoutHandle);
      this.requestTimeoutHandle = undefined;
    }
    if (this.inactivityTimeoutHandle !== undefined) {
      clearTimeout(this.inactivityTimeoutHandle);
      this.inactivityTimeoutHandle = undefined;
    }
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimeoutHandle !== undefined) {
      clearTimeout(this.inactivityTimeoutHandle);
      this.inactivityTimeoutHandle = undefined;
    }
    if (this.inactivityTimeoutMs <= 0 || this.abortReason !== null) {
      return;
    }
    this.inactivityTimeoutHandle = setTimeout(() => {
      this.abort("request_inactivity_timeout");
    }, this.inactivityTimeoutMs);
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
