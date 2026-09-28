import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LearningCollectionSource } from "../passive-learning/collection-source.js";
import type { PassiveLearningConnection } from "../passive-learning/contracts.js";
import type {
  HostObservationEvent,
  PassiveCollectionState,
} from "../../shared/passive-observation.js";

type ConnectionInput = Parameters<PassiveLearningConnection>[0];
const sources: LearningCollectionSource[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const source of sources.splice(0)) source.close();
  vi.useRealTimers();
});

function fixture() {
  let enabled = true;
  const connections: {
    input: ConnectionInput;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const connect = vi.fn<PassiveLearningConnection>(async (input) => {
    const connection = { input, close: vi.fn() };
    connections.push(connection);
    return connection;
  });
  const event = vi.fn();
  const failed = vi.fn();
  const source = new LearningCollectionSource({
    ownerId: "environment:dev",
    connect,
    enabled: () => enabled,
    excludedApplications: () => ["private-app"],
    opening: vi.fn(),
    event,
    failed,
  });
  sources.push(source);
  const status = (
    state: PassiveCollectionState,
    reason?: string,
    index = connections.length - 1,
  ) => {
    const input = connections[index]!.input;
    const value: HostObservationEvent = {
      type: "status",
      state,
      reason,
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      deviceId: "paired-device",
    };
    input.onEvent(value);
    return value;
  };
  return {
    source,
    connect,
    connections,
    event,
    failed,
    status,
    disable: () => {
      enabled = false;
    },
  };
}

describe("passive collection source recovery", () => {
  test.each([
    ["unavailable", "collector_stopped"],
    ["unavailable", "collector_start_failed"],
    ["failed", "collector_start_failed"],
    ["failed", "collector_protocol_invalid"],
    ["failed", "collector_output_limit"],
    ["disconnected", "host_disconnected"],
  ] as const)(
    "reopens a fresh lease after %s / %s while the old transport stays open",
    async (state, reason) => {
      const f = fixture();
      await f.source.open();
      const old = f.connections[0]!;
      const failure = f.status(state, reason);
      expect(f.event).toHaveBeenLastCalledWith(failure);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(f.connect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(old.input.abortSignal.aborted).toBe(true);
      expect(old.close).toHaveBeenCalledOnce();
      expect(f.connections[1]!.input.leaseId).not.toBe(old.input.leaseId);
      expect(f.connections[1]!.input.ownerId).toBe(old.input.ownerId);
      expect(f.connections[1]!.input.excludedApplications).toEqual([
        "private-app",
      ]);
      const received = f.event.mock.calls.length;
      f.status("unavailable", "collector_start_failed", 0);
      expect(f.event).toHaveBeenCalledTimes(received);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.connect).toHaveBeenCalledTimes(2);
      f.status("collecting");
      expect(f.event).toHaveBeenCalledTimes(received + 1);
    },
  );

  test.each([
    ["permission_required", "macos_accessibility_permission_required"],
    ["unavailable", "platform_unsupported"],
    ["unavailable", "collector_dependency_unavailable"],
    ["unavailable", "macos_swift_tools_unavailable"],
  ] as const)("does not retry actionable %s / %s", async (state, reason) => {
    const f = fixture();
    await f.source.open();
    const value = f.status(state, reason);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.event).toHaveBeenLastCalledWith(value);
  });

  test.each(["collecting", "partial"] as const)("duplicate exits share capped backoff, and %s collection resets it", async (healthyState) => {
    const f = fixture();
    await f.source.open();
    for (const wait of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      const attempts = f.connect.mock.calls.length;
      f.status("unavailable", "collector_start_failed");
      f.status("unavailable", "collector_start_failed");
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(f.connect).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.connect).toHaveBeenCalledTimes(attempts + 1);
    }
    f.status(healthyState);
    f.status("unavailable", "collector_stopped");
    const attempts = f.connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.connect).toHaveBeenCalledTimes(attempts + 1);
  });

  test.each(["close", "disable"])(
    "%s prevents a scheduled recovery and rejects later events",
    async (action) => {
      const f = fixture();
      await f.source.open();
      f.status("unavailable", "collector_stopped");
      const received = f.event.mock.calls.length;
      if (action === "close") f.source.close();
      if (action === "disable") f.disable();
      f.status("unavailable", "collector_stopped");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.event).toHaveBeenCalledTimes(received);
    },
  );

  test("events from a different owner or lease cannot schedule recovery", async () => {
    const f = fixture();
    await f.source.open();
    const current = f.connections[0]!.input;
    for (const binding of [
      { ownerId: "another-owner", leaseId: current.leaseId },
      { ownerId: current.ownerId, leaseId: "another-lease" },
    ]) {
      current.onEvent({
        type: "status",
        state: "unavailable",
        reason: "collector_start_failed",
        deviceId: "paired-device",
        ...binding,
      });
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.event).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
