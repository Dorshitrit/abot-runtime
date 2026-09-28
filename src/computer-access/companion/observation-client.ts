import { connect } from "node:net";
import type {
  HostObservationEvent,
  HostObservationSubscription,
} from "../../shared/passive-observation.js";
import { readBrokerLocation } from "./broker-location.js";
import { isHostIdentifier, isHostRecord } from "./protocol.js";
import {
  isPassiveCollectorEvent,
  OBSERVATION_RENEW_MS,
  OBSERVATION_WIRE_LIMIT,
} from "./observation-protocol.js";

export async function connectHostObservations(
  options: HostObservationSubscription,
): Promise<{ close(): void }> {
  options.abortSignal.throwIfAborted();
  const location = readBrokerLocation(options.rootDir);
  if (!location) throw new Error("host_broker_unavailable");
  return new Promise((resolve, reject) => {
    const socket = connect(location.socketPath);
    let received = Buffer.alloc(0);
    let ready = false;
    let closed = false;
    let deviceId: string | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(
      () => finish(new Error("host_observation_connect_timeout")),
      5_000,
    );
    const close = () => finish();
    const abort = () => finish(new Error("host_observation_cancelled"));
    function finish(error?: Error): void {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      if (renewal) clearInterval(renewal);
      options.abortSignal.removeEventListener("abort", abort);
      socket.destroy();
      if (!ready) reject(error ?? new Error("host_observation_closed"));
      if (ready && error && deviceId && !options.abortSignal.aborted)
        options.onEvent({
          type: "status",
          state: "disconnected",
          reason: error.message,
          deviceId,
          ownerId: options.ownerId,
          leaseId: options.leaseId,
        });
    }
    options.abortSignal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          kind: "observe",
          version: 1,
          token: location.token,
          ownerId: options.ownerId,
          leaseId: options.leaseId,
          excludedApplications: options.excludedApplications,
        }) + "\n",
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > OBSERVATION_WIRE_LIMIT * 2) {
        finish(new Error("host_observation_too_large"));
        return;
      }
      let boundary = received.indexOf(10);
      while (boundary >= 0) {
        try {
          if (boundary > OBSERVATION_WIRE_LIMIT)
            throw new Error("host_observation_too_large");
          const message: unknown = JSON.parse(
            received.subarray(0, boundary).toString(),
          );
          if (!isHostRecord(message))
            throw new Error("invalid_observation_response");
          if (!ready) {
            if (message.ok !== true || message.subscribed !== true)
              throw new Error(
                String(message.error ?? "host_observation_rejected"),
              );
            if (!isHostIdentifier(message.deviceId))
              throw new Error("invalid_observation_binding");
            deviceId = message.deviceId;
            ready = true;
            clearTimeout(deadline);
            renewal = setInterval(
              () =>
                socket.write(
                  JSON.stringify({ kind: "renew", leaseId: options.leaseId }) +
                    "\n",
                ),
              OBSERVATION_RENEW_MS,
            );
            resolve({ close });
          } else {
            const event = message.event;
            if (!isHostRecord(event))
              throw new Error("invalid_observation_event");
            if (
              event.ownerId !== options.ownerId ||
              event.leaseId !== options.leaseId ||
              !isHostIdentifier(event.deviceId)
            )
              throw new Error("invalid_observation_binding");
            deviceId = event.deviceId;
            if (!isPassiveCollectorEvent(event))
              throw new Error("invalid_observation_event");
            options.onEvent(event as HostObservationEvent);
          }
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error("invalid_observation_response"),
          );
          return;
        }
        received = received.subarray(boundary + 1);
        boundary = received.indexOf(10);
      }
    });
    socket.on("error", () => finish(new Error("host_broker_unavailable")));
    socket.on("close", () => {
      finish(new Error("host_broker_disconnected"));
    });
    if (options.abortSignal.aborted) abort();
  });
}
