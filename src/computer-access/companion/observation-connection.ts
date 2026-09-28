import WebSocket from "ws";
import type { HostObservationEvent } from "../../shared/passive-observation.js";
import {
  OBSERVATION_LEASE_MS,
  OBSERVATION_WIRE_LIMIT,
  isPassiveCollectorEvent,
} from "./observation-protocol.js";
import type { ObservationControl } from "./observation-protocol.js";

type Lease = {
  ownerId: string;
  leaseId: string;
  emit(event: HostObservationEvent): void;
  deadline: ReturnType<typeof setTimeout>;
  sequence: number;
};

/** One device, one environment owner. Lifetime is bounded by both transports and a lease. */
export class HostObservationConnection {
  private client?: WebSocket;
  private deviceId?: string;
  private capable = false;
  private lease?: Lease;

  attach(client: WebSocket, deviceId: string, capable: boolean): void {
    this.client = client;
    this.deviceId = deviceId;
    this.capable = capable;
  }
  subscribe(input: {
    ownerId: string;
    leaseId: string;
    excludedApplications?: readonly string[];
    onEvent(event: HostObservationEvent): void;
  }): { renew(): void; close(): void } {
    if (this.client?.readyState !== WebSocket.OPEN)
      throw new Error("host_disconnected");
    if (!this.capable) throw new Error("host_observations_unsupported");
    if (this.lease) throw new Error("host_observations_already_owned");
    const lease: Lease = {
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      emit: input.onEvent,
      deadline: setTimeout(() => this.expire(lease), OBSERVATION_LEASE_MS),
      sequence: 0,
    };
    this.lease = lease;
    this.send({
      type: "observe_start",
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      excludedApplications: input.excludedApplications,
    });
    return {
      renew: () => {
        if (this.lease !== lease)
          throw new Error("host_observation_lease_expired");
        clearTimeout(lease.deadline);
        lease.deadline = setTimeout(
          () => this.expire(lease),
          OBSERVATION_LEASE_MS,
        );
        this.send({
          type: "observe_renew",
          ownerId: lease.ownerId,
          leaseId: lease.leaseId,
        });
      },
      close: () => this.release(lease),
    };
  }
  receive(client: WebSocket, message: Record<string, unknown>): void {
    if (client !== this.client)
      throw new Error("host_observation_source_mismatch");
    const lease = this.lease;
    if (!lease) return;
    if (message.leaseId !== lease.leaseId || message.ownerId !== lease.ownerId)
      return;
    if (!isPassiveCollectorEvent(message.event))
      throw new Error("invalid_host_observation");
    if (Buffer.byteLength(JSON.stringify(message)) > OBSERVATION_WIRE_LIMIT)
      throw new Error("host_observation_too_large");
    if (message.event.type === "observation") {
      if (message.event.observation.sequence <= lease.sequence) return;
      lease.sequence = message.event.observation.sequence;
    }
    lease.emit({
      ...message.event,
      deviceId: this.deviceId!,
      ownerId: lease.ownerId,
      leaseId: lease.leaseId,
    });
  }
  disconnect(): void {
    const lease = this.lease;
    if (lease) {
      lease.emit({
        type: "status",
        state: "disconnected",
        reason: "host_disconnected",
        deviceId: this.deviceId!,
        ownerId: lease.ownerId,
        leaseId: lease.leaseId,
      });
      this.release(lease);
    }
    this.client = undefined;
    this.deviceId = undefined;
    this.capable = false;
  }
  private send(control: ObservationControl): void {
    if (this.client?.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(control));
  }
  private expire(lease: Lease): void {
    if (this.lease !== lease) return;
    lease.emit({
      type: "status",
      state: "stopped",
      reason: "lease_expired",
      deviceId: this.deviceId!,
      ownerId: lease.ownerId,
      leaseId: lease.leaseId,
    });
    this.release(lease);
  }
  private release(lease: Lease): void {
    if (this.lease !== lease) return;
    this.lease = undefined;
    clearTimeout(lease.deadline);
    this.send({
      type: "observe_stop",
      ownerId: lease.ownerId,
      leaseId: lease.leaseId,
    });
  }
}
