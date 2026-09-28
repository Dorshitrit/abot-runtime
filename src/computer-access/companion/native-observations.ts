import type { PassiveCollectorEvent } from "../../shared/passive-observation.js";
import {
  startDesktopCollector,
  type DesktopCollector,
} from "./observation-process.js";
import {
  OBSERVATION_LEASE_MS,
  type ObservationControl,
} from "./observation-protocol.js";

export type ObservationCollectorFactory = (options: {
  excludedApplications: readonly string[];
  onEvent(event: PassiveCollectorEvent): void;
}) => DesktopCollector;

export class NativeObservationSession {
  private lease?: {
    ownerId: string;
    leaseId: string;
    collector: DesktopCollector;
    deadline: ReturnType<typeof setTimeout>;
  };
  constructor(
    private readonly send: (message: unknown) => void,
    private readonly start: ObservationCollectorFactory = startDesktopCollector,
  ) {}
  receive(control: ObservationControl): void {
    if (control.type === "observe_start") {
      if (this.lease) throw new Error("observation_lease_already_active");
      const lease = {
        ownerId: control.ownerId,
        leaseId: control.leaseId,
        collector: { close() {} },
        deadline: setTimeout(() => this.close(), OBSERVATION_LEASE_MS),
      };
      this.lease = lease;
      const onEvent = (event: PassiveCollectorEvent) => {
        if (this.lease !== lease) return;
        this.send({
          type: "observation_event",
          ownerId: lease.ownerId,
          leaseId: lease.leaseId,
          event,
        });
      };
      try {
        lease.collector = this.start({
          excludedApplications: control.excludedApplications ?? [],
          onEvent,
        });
      } catch {
        onEvent({
          type: "status",
          state: "failed",
          reason: "collector_start_failed",
        });
      }
      return;
    }
    const lease = this.lease;
    if (
      !lease ||
      lease.ownerId !== control.ownerId ||
      lease.leaseId !== control.leaseId
    )
      return;
    if (control.type === "observe_stop") {
      this.close();
      return;
    }
    clearTimeout(lease.deadline);
    lease.deadline = setTimeout(() => this.close(), OBSERVATION_LEASE_MS);
  }
  close(): void {
    const lease = this.lease;
    if (!lease) return;
    this.lease = undefined;
    clearTimeout(lease.deadline);
    lease.collector.close();
  }
}
