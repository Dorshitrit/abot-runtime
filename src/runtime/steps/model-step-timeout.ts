import type { ModelStep } from "../../shared/model-steps.js";
import { randomUUID } from "node:crypto";
import { attachSourceIssueId } from "../../shared/source-issue.js";

/** Identifies a deadline owned by one model step, never the request budget. */
export class ModelStepTimeoutError extends Error {
  readonly stage = "model_step_timeout";
  readonly issueId = randomUUID();
  readonly occurredAt = Date.now();

  constructor(
    readonly code: string,
    readonly modelStep: ModelStep,
    readonly timeoutMs?: number,
  ) {
    super(code);
    this.name = "ModelStepTimeoutError";
    attachSourceIssueId(this, this.issueId);
  }
}

export function createModelStepAbort(params: {
  parentSignal: AbortSignal;
  modelStep: ModelStep;
  timeoutMs: number;
  timeoutReason: string;
}): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(params.parentSignal.reason);
  };

  if (params.parentSignal.aborted) {
    abortFromParent();
  } else {
    params.parentSignal.addEventListener("abort", abortFromParent, {
      once: true,
    });
  }

  const timeout = setTimeout(() => {
    controller.abort(
      new ModelStepTimeoutError(params.timeoutReason, params.modelStep, params.timeoutMs),
    );
  }, params.timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      params.parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}
