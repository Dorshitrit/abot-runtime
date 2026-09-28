import type { Socket } from "node:net";
import type { HostConnection } from "./connection.js";
import { isHostIdentifier, isHostRecord } from "./protocol.js";
import {
  isApplicationExclusionList,
  isObservationOwner,
  OBSERVATION_WIRE_LIMIT,
} from "./observation-protocol.js";

/** Called only after broker authentication. Subsequent traffic is lease renewal, never data polling. */
export function serveObservationSubscription(
  socket: Socket,
  connection: HostConnection,
  input: Record<string, unknown>,
): void {
  if (!connection.status().paired) throw new Error("host_not_paired");
  if (!isObservationOwner(input.ownerId) || !isHostIdentifier(input.leaseId))
    throw new Error("invalid_observation_owner");
  if (
    input.excludedApplications !== undefined &&
    !isApplicationExclusionList(input.excludedApplications)
  )
    throw new Error("invalid_observation_exclusions");
  const send = (value: unknown) => {
    if (socket.destroyed) return;
    const bytes = JSON.stringify(value) + "\n";
    if (
      Buffer.byteLength(bytes) > OBSERVATION_WIRE_LIMIT ||
      socket.writableLength > OBSERVATION_WIRE_LIMIT * 2
    ) {
      socket.destroy();
      return;
    }
    socket.write(bytes);
  };
  const lease = connection.observations.subscribe({
    ownerId: input.ownerId,
    leaseId: input.leaseId,
    excludedApplications: input.excludedApplications as string[] | undefined,
    onEvent: (event) => {
      send({ event });
      if (
        event.type === "status" &&
        ["disconnected", "stopped"].includes(event.state)
      )
        socket.end();
    },
  });
  socket.once("close", () => lease.close());
  let received = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    if (received.length > 4096) {
      socket.destroy();
      return;
    }
    let boundary = received.indexOf(10);
    while (boundary >= 0) {
      try {
        const message: unknown = JSON.parse(
          received.subarray(0, boundary).toString(),
        );
        if (
          !isHostRecord(message) ||
          message.kind !== "renew" ||
          message.leaseId !== input.leaseId
        )
          throw new Error("invalid_renewal");
        lease.renew();
      } catch {
        socket.destroy();
        return;
      }
      received = received.subarray(boundary + 1);
      boundary = received.indexOf(10);
    }
  });
  send({ ok: true, subscribed: true, deviceId: connection.status().hostId });
}
