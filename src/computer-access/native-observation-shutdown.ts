import { resolve } from "node:path";

type StoppingObservationLease = Readonly<{ waiters: Set<() => void> }>;
const stoppingLeases = new Map<string, StoppingObservationLease>();
const NATIVE_OBSERVATION_SHUTDOWN_WAIT_MS = 2_000;

function shutdownKey(rootDir: string, ownerId: string): string {
  const root = resolve(rootDir);
  return JSON.stringify([process.platform === "win32" ? root.toLowerCase() : root, ownerId]);
}

/** A replacement waits only for this process's same installation and environment owner. */
export async function waitForNativeObservationShutdown(
  rootDir: string, ownerId: string, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const previous = stoppingLeases.get(shutdownKey(rootDir, ownerId));
  if (!previous) return;
  const waiters = previous.waiters;
  await new Promise<void>((resolveWait, rejectWait) => {
    let finished = false;
    function finish(error?: unknown): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      waiters.delete(released);
      if (error !== undefined) rejectWait(error);
      else resolveWait();
    }
    function abort(): void { finish(signal.reason ?? new Error("host_observation_cancelled")); }
    function released(): void { finish(); }
    const timer = setTimeout(() => finish(new Error("host_observations_already_owned")), NATIVE_OBSERVATION_SHUTDOWN_WAIT_MS);
    signal.addEventListener("abort", abort, { once: true });
    waiters.add(released);
    if (signal.aborted) abort();
  });
}

/** The caller confirms release only after helper exit and successful physical lock cleanup. */
export function createNativeObservationShutdown(rootDir: string, ownerId: string) {
  const key = shutdownKey(rootDir, ownerId);
  let released = false;
  const entry: StoppingObservationLease = { waiters: new Set() };
  return {
    begin(): void {
      if (!released) stoppingLeases.set(key, entry);
    },
    confirmReleased(): void {
      if (released) return;
      released = true;
      if (stoppingLeases.get(key) === entry) stoppingLeases.delete(key);
      for (const waiter of entry.waiters) waiter();
    },
  };
}
