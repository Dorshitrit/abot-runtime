import type { LocalRuntimeOwner } from "./contracts.js";

/** Releasing a live owner's lease is separate from closing client transport. */
export function releaseRuntimeOwnerWhenIdle(
  owner: LocalRuntimeOwner | undefined,
  release: () => Promise<void>,
): Promise<void> {
  if (!owner?.whenIdle) return release();
  const alreadyIdle = owner.isIdle?.() === true;
  const retirement = owner.whenIdle().then(release);
  if (alreadyIdle) return retirement;
  void retirement.catch((error: unknown) => {
    // Fail closed: uncertainty must never admit a second environment writer.
    // A true process exit still permits the normal abandoned-PID recovery.
    console.error("Local runtime owner retirement failed:", error);
  });
  return Promise.resolve();
}
