export function createModelStepAbort(params: {
  parentSignal: AbortSignal;
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
    controller.abort(new Error(params.timeoutReason));
  }, params.timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      params.parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}
