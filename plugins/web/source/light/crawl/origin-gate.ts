import { withinDeadline } from "../../deadline.js";
import { WebPluginError } from "../../errors.js";

type Release = () => void;
type Waiter = {
  origin: string;
  resolve: (release: Release) => void;
  reject: (error: WebPluginError) => void;
  signal: AbortSignal;
  onAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createOriginGate(maxActive: number, maxPerOrigin: number) {
  const activeOrigins = new Map<string, number>();
  const queue: Waiter[] = [];
  let active = 0;
  const hasOriginCapacity = (origin: string) =>
    (activeOrigins.get(origin) ?? 0) < maxPerOrigin;

  const canStartOriginRequest = (origin: string) => {
    if (active >= maxActive) return false;
    return hasOriginCapacity(origin);
  };

  const takePermit = (origin: string): Release => {
    active += 1;
    activeOrigins.set(origin, (activeOrigins.get(origin) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const remaining = activeOrigins.get(origin)! - 1;
      if (remaining === 0) activeOrigins.delete(origin);
      else activeOrigins.set(origin, remaining);
      drain();
    };
  };

  const clearWaiter = (waiter: Waiter) => {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  };

  const drain = () => {
    while (active < maxActive) {
      const index = queue.findIndex((waiter) =>
        hasOriginCapacity(waiter.origin),
      );
      if (index < 0) return;
      const waiter = queue.splice(index, 1)[0]!;
      clearWaiter(waiter);
      waiter.resolve(takePermit(waiter.origin));
    }
  };

  const acquire = (
    origin: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Release> => {
    if (signal.aborted) {
      return Promise.reject(
        new WebPluginError(
          "web_request_aborted",
          "The web request was aborted.",
        ),
      );
    }
    if (Date.now() >= deadline) {
      return Promise.reject(
        new WebPluginError(
          "web_request_timed_out",
          "The Light search exceeded its deadline.",
        ),
      );
    }
    if (canStartOriginRequest(origin)) {
      return Promise.resolve(takePermit(origin));
    }
    if (queue.length >= 64) {
      return Promise.reject(
        new WebPluginError(
          "web_request_capacity_exceeded",
          "The Light search request queue is full.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const fail = (code: "web_request_aborted" | "web_request_timed_out") => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        clearWaiter(waiter);
        reject(
          new WebPluginError(
            code,
            "The queued Light request could not continue.",
          ),
        );
      };
      const waiter: Waiter = {
        origin,
        resolve,
        reject,
        signal,
        onAbort: () => fail("web_request_aborted"),
        timer: setTimeout(
          () => fail("web_request_timed_out"),
          Math.max(1, deadline - Date.now()),
        ),
      };
      waiter.timer.unref?.();
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      queue.push(waiter);
    });
  };

  return Object.freeze({
    async run<T>(
      origin: string,
      deadline: number,
      signal: AbortSignal,
      operation: () => Promise<T>,
    ): Promise<T> {
      const release = await acquire(origin, deadline, signal);
      const work = Promise.resolve().then(operation);
      // Keep capacity reserved if an injected or non-cancellable operation outlives abort.
      void work.then(release, release);
      return await withinDeadline(work, deadline, signal);
    },
  });
}
