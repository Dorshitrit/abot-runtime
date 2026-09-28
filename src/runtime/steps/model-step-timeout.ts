import type { ModelStep } from "../../shared/model-steps.js";

/** Identifies a deadline owned by one model step, never the request budget. */
export class ModelStepTimeoutError extends Error {
  readonly stage = "model_step_timeout";

  constructor(
    readonly code: string,
    readonly modelStep: ModelStep,
  ) {
    super(code);
    this.name = "ModelStepTimeoutError";
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
      new ModelStepTimeoutError(params.timeoutReason, params.modelStep),
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
