import type { HostObservationSubscription } from "../../shared/passive-observation.js";
import { connectHostObservations } from "../../computer-access/companion/observation-client.js";
import { connectNativeObservations } from "../../computer-access/native-observation-connection.js";
import { requireCollectionConsent } from "../../computer-access/collection-consent.js";
import { readRuntimeCollectionSource } from "../../computer-access/observation-source.js";

/** Installation consent gates every collection route before transport or helper startup. */
export async function connectRuntimeObservations(options: HostObservationSubscription) {
  options.abortSignal.throwIfAborted();
  await requireCollectionConsent(options.rootDir);
  options.abortSignal.throwIfAborted();
  if (readRuntimeCollectionSource().mode === "native") return connectNativeObservations(options);
  return connectHostObservations(options);
}
