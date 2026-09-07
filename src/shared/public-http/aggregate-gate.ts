import { remainingTime, withinDeadline } from "./deadline.js";
import { PublicHttpError } from "./errors.js";

type Release = () => void;

type Waiter = {
  resolve: (release: Release) => void;
  reject: (error: PublicHttpError) => void;
  deadline: number;
  abortSignal?: AbortSignal;
  timeout?: NodeJS.Timeout;
  onAbort?: () => void;
};

export function createAggregateGate(maxActive: number, maxQueued: number) {
  let active = 0;
  const queue: Waiter[] = [];

  const startQueued = () => {
    while (active < maxActive && queue.length > 0) {
      const waiter = queue.shift()!;
      clearTimeout(waiter.timeout);
      if (waiter.onAbort) {
        waiter.abortSignal?.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.abortSignal?.aborted) {
        waiter.reject(
          new PublicHttpError(
            "web_request_aborted",
            "The web request was aborted.",
          ),
        );
        continue;
      }
      if (waiter.deadline <= Date.now()) {
        waiter.reject(
          new PublicHttpError(
            "web_request_timed_out",
            "The upstream web request timed out.",
          ),
        );
        continue;
      }
      active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        startQueued();
      });
    }
  };

  const acquire = (
    deadline: number,
    abortSignal?: AbortSignal,
  ): Promise<Release> => {
    if (abortSignal?.aborted) {
      return Promise.reject(
        new PublicHttpError(
          "web_request_aborted",
          "The web request was aborted.",
        ),
      );
    }
    if (active < maxActive) {
      active += 1;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        startQueued();
      });
    }
    if (queue.length >= maxQueued) {
      return Promise.reject(
        new PublicHttpError(
          "web_request_capacity_exceeded",
          "The web client is at its bounded request capacity.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        deadline,
        ...(abortSignal ? { abortSignal } : {}),
      };
      const remove = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
      };
      const fail = (error: PublicHttpError) => {
        remove();
        clearTimeout(waiter.timeout);
        if (waiter.onAbort) {
          abortSignal?.removeEventListener("abort", waiter.onAbort);
        }
        reject(error);
      };
      waiter.onAbort = () =>
        fail(
          new PublicHttpError(
            "web_request_aborted",
            "The web request was aborted.",
          ),
        );
      waiter.timeout = setTimeout(
        () =>
          fail(
            new PublicHttpError(
              "web_request_timed_out",
              "The upstream web request timed out.",
            ),
          ),
        remainingTime(deadline),
      );
      waiter.timeout.unref?.();
      abortSignal?.addEventListener("abort", waiter.onAbort, { once: true });
      queue.push(waiter);
    });
  };

  return Object.freeze({
    async run<T>(
      operation: () => Promise<T>,
      deadline: number,
      abortSignal?: AbortSignal,
    ): Promise<T> {
      const release = await acquire(deadline, abortSignal);
      const rawWork = Promise.resolve().then(operation);
      // A deadline rejects the visible operation promptly, but the capacity slot
      // remains held until non-cancellable DNS or transport work actually settles.
      void rawWork.then(release, release);
      return await withinDeadline(rawWork, deadline, abortSignal);
    },
  });
}
