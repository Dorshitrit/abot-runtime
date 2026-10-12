import type { HostObservationSubscription, PassiveCollectorEvent } from "../shared/passive-observation.js";
import { startDesktopCollector, type DesktopCollector } from "./companion/observation-process.js";
import { acquireNativeObservationOwnership } from "./native-observation-ownership.js";
import { createNativeObservationShutdown, waitForNativeObservationShutdown } from "./native-observation-shutdown.js";

type NativeObservationDependencies = Readonly<{
  acquireOwnership?: typeof acquireNativeObservationOwnership;
  startCollector?: typeof startDesktopCollector;
}>;

function canPublishNativeObservation(closed: boolean, signal: AbortSignal): boolean {
  if (closed) return false;
  return !signal.aborted;
}

/** Local transport retains the existing collector's filtering and the source's owner/lease contract. */
export async function connectNativeObservations(
  options: HostObservationSubscription,
  dependencies: NativeObservationDependencies = {},
): Promise<Readonly<{ close(): void }>> {
  await waitForNativeObservationShutdown(options.rootDir, options.ownerId, options.abortSignal);
  options.abortSignal.throwIfAborted();
  const ownership = await (dependencies.acquireOwnership ?? acquireNativeObservationOwnership)(options.rootDir);
  const shutdown = createNativeObservationShutdown(options.rootDir, options.ownerId);
  let collector: DesktopCollector | undefined;
  let closed = false;
  let starting = true;
  let stopped = false;
  function onStopped(): void {
    if (stopped) return;
    stopped = true;
    closed = true;
    options.abortSignal.removeEventListener("abort", close);
    shutdown.begin();
    void ownership.release().then(() => shutdown.confirmReleased()).catch(() => process.emitWarning(
      "Native collection ownership could not be released.", { code: "NATIVE_OBSERVATION_RELEASE_FAILED" },
    ));
  }
  function stopCollector(): void {
    if (stopped) return;
    try { collector?.close(); }
    catch { process.emitWarning("Native collector stop was not confirmed; its ownership is retained.",
      { code: "NATIVE_OBSERVATION_STOP_UNCONFIRMED" }); }
  }
  function close(): void {
    if (closed) return;
    closed = true;
    shutdown.begin();
    options.abortSignal.removeEventListener("abort", close);
    if (!starting) stopCollector();
  }
  function onEvent(event: PassiveCollectorEvent): void {
    if (!canPublishNativeObservation(closed, options.abortSignal)) return;
    try {
      options.onEvent({ ...event, deviceId: ownership.deviceId, ownerId: options.ownerId, leaseId: options.leaseId });
    } catch {
      process.emitWarning("Native observation delivery failed; collection is closing.",
        { code: "NATIVE_OBSERVATION_DELIVERY_FAILED" });
      close();
    }
  }
  options.abortSignal.addEventListener("abort", close, { once: true });
  if (options.abortSignal.aborted) {
    onStopped();
    options.abortSignal.throwIfAborted();
  }
  try {
    collector = (dependencies.startCollector ?? startDesktopCollector)({
      excludedApplications: options.excludedApplications ?? [], onEvent, onStopped,
    });
  } catch {
    onEvent({ type: "status", state: "failed", reason: "collector_start_failed" });
    close();
  } finally {
    starting = false;
    if (closed) stopCollector();
  }
  return { close };
}
