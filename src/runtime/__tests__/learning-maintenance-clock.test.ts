import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningMaintenanceClock } from "../long-term-memory/maturation/maintenance-clock.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import type { LearningMemoryMaintenance } from "../long-term-memory/maturation/contracts.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-25T10:00:00Z")); });
afterEach(() => vi.useRealTimers());

function fixture(initialDeadline: string | null = null) {
  let deadline = initialDeadline;
  const memory = {
    nextExpiryAt: vi.fn(async () => deadline),
    maintenance: vi.fn(async (): Promise<LearningMemoryMaintenance> => {
      deadline = null;
      return { removedCandidateCount: 1, removedReceiptCount: 0, nextExpiryAt: null };
    }),
  };
  const changed = vi.fn();
  const failed = vi.fn();
  const clock = new LearningMaintenanceClock({ memory, policy: () => DEFAULT_MATURATION_POLICY, changed, failed });
  return { clock, memory, changed, failed, setDeadline: (value: string | null) => { deadline = value; } };
}

describe("learning retention deadline clock", () => {
  it("creates no timer or repeated work when there is nothing to expire", async () => {
    const f = fixture();
    await f.clock.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7 * 86_400_000);
    expect(f.memory.nextExpiryAt).toHaveBeenCalledTimes(1);
    expect(f.memory.maintenance).not.toHaveBeenCalled();
    await f.clock.stop();
  });

  it("maintains once at the actual expiry without requiring collection or inference", async () => {
    const f = fixture("2026-09-25T10:01:00Z");
    await f.clock.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.memory.maintenance).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.memory.maintenance).toHaveBeenCalledExactlyOnceWith(DEFAULT_MATURATION_POLICY);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.clock.scheduledAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(f.memory.maintenance).toHaveBeenCalledTimes(1);
    await f.clock.stop();
  });

  it("handles expired startup state and policy changes without leaving a periodic timer", async () => {
    const f = fixture("2026-09-24T10:00:00Z");
    await f.clock.start();
    expect(f.memory.maintenance).toHaveBeenCalledTimes(1);
    f.memory.maintenance.mockResolvedValueOnce({ removedCandidateCount: 0, removedReceiptCount: 0, nextExpiryAt: null });
    await f.clock.preferencesChanged();
    expect(f.memory.maintenance).toHaveBeenCalledTimes(2);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.clock.stop();
  });

  it("re-arms for new knowledge and stops the single timer on shutdown", async () => {
    const f = fixture("2026-09-26T10:00:00Z");
    await f.clock.start();
    f.setDeadline("2026-09-25T10:02:00Z");
    await f.clock.knowledgeChanged();
    expect(vi.getTimerCount()).toBe(1);
    expect(f.clock.scheduledAt).toBe(Date.parse("2026-09-25T10:02:00Z"));
    await f.clock.stop();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.memory.maintenance).not.toHaveBeenCalled();
  });

  it("does not overflow a 30-day timeout into a millisecond loop", async () => {
    const f = fixture("2026-10-25T10:00:00Z");
    await f.clock.start();
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(f.memory.maintenance).not.toHaveBeenCalled();
    expect(f.memory.nextExpiryAt).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 86_400_000 - 2_147_483_647);
    expect(f.memory.maintenance).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.clock.stop();
  });

  it("reports storage failure once and does not start a retry loop", async () => {
    const f = fixture("2026-09-25T10:01:00Z");
    f.memory.maintenance.mockRejectedValueOnce(new Error("storage unavailable"));
    await f.clock.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(f.memory.maintenance).toHaveBeenCalledTimes(1);
    await f.clock.stop();
  });

  it("coalesces knowledge events arriving while the deadline read is pending", async () => {
    const f = fixture();
    let release: (deadline: string | null) => void = () => undefined;
    f.memory.nextExpiryAt.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const started = f.clock.start();
    await Promise.resolve();
    const changes = Array.from({ length: 50 }, () => f.clock.knowledgeChanged());
    release(null);
    await Promise.all([started, ...changes]);
    expect(f.memory.nextExpiryAt).toHaveBeenCalledTimes(2);
    expect(f.memory.maintenance).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await f.clock.stop();
  });
});
