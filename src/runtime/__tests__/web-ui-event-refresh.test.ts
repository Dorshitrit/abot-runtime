import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createEventRefresh } from "../../web-ui/app/lib/event-refresh.js";

afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("event-driven refresh coordination", () => {
  test("coalesces a burst into one short timer and stays idle afterward", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const updates = createEventRefresh({ canRefresh: () => true, refresh });
    updates.schedule();
    updates.schedule();
    updates.schedule();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(79);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  test("run is immediate and events during a read produce one serialized follow-up", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const second = deferred();
    const refresh = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const updates = createEventRefresh({ canRefresh: () => true, refresh });
    const completion = updates.run();
    expect(refresh).toHaveBeenCalledOnce();
    updates.schedule();
    updates.schedule();
    expect(updates.run()).toBe(completion);
    expect(vi.getTimerCount()).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    second.resolve();
    await completion;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("cancelling hidden work removes a queued update", async () => {
    vi.useFakeTimers();
    let visible = true;
    const pending = deferred();
    const refresh = vi.fn(() => pending.promise);
    const updates = createEventRefresh({ canRefresh: () => visible, refresh });
    const completion = updates.run();
    updates.schedule();
    visible = false;
    updates.cancel();
    updates.schedule();
    pending.resolve();
    await completion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a new scope starts immediately even when the cancelled old read is stalled", async () => {
    const oldRead = deferred();
    const newRead = deferred();
    const refresh = vi
      .fn()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    const updates = createEventRefresh({ canRefresh: () => true, refresh });
    const oldCompletion = updates.run();
    updates.schedule();
    updates.cancel();
    const newCompletion = updates.run();
    expect(refresh).toHaveBeenCalledTimes(2);
    oldRead.resolve();
    await oldCompletion;
    expect(refresh).toHaveBeenCalledTimes(2);
    newRead.resolve();
    await newCompletion;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("reports read failure and allows a later explicit update", async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce(undefined);
    const updates = createEventRefresh({ canRefresh: () => true, refresh });
    await expect(updates.run()).rejects.toThrow("Unavailable");
    await updates.run();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
