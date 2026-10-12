import { afterEach, expect, test, vi } from "vitest";
import { createNativeObservationShutdown, waitForNativeObservationShutdown } from "../../computer-access/native-observation-shutdown.js";

let fixtureId = 0;
function fixture() {
  const root = `shutdown-root-${++fixtureId}`, owner = "dev", abort = new AbortController();
  const lease = createNativeObservationShutdown(root, owner);
  return { root, owner, abort, lease, wait: () => waitForNativeObservationShutdown(root, owner, abort.signal) };
}
afterEach(() => vi.useRealTimers());

test("only a stopping lease from the same root and owner delays its replacement", async () => {
  const f = fixture();
  await f.wait();
  f.lease.begin();
  await waitForNativeObservationShutdown(f.root, "other-environment", f.abort.signal);
  await waitForNativeObservationShutdown(f.root + "-other", f.owner, f.abort.signal);
  const complete = vi.fn();
  const pending = f.wait().then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  f.lease.confirmReleased(); await pending;
  expect(complete).toHaveBeenCalledOnce();
});

test("abort ends a replacement wait without declaring the old lease released", async () => {
  vi.useFakeTimers();
  const f = fixture(); f.lease.begin();
  const pending = f.wait();
  f.abort.abort(new Error("replacement_cancelled"));
  await expect(pending).rejects.toThrow("replacement_cancelled");
  expect(vi.getTimerCount()).toBe(0);
  const complete = vi.fn();
  const replacement = waitForNativeObservationShutdown(f.root, f.owner, new AbortController().signal).then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  f.lease.confirmReleased(); await replacement;
  expect(vi.getTimerCount()).toBe(0);
});

test("an unconfirmed shutdown times out after two seconds and remains owned", async () => {
  vi.useFakeTimers();
  const f = fixture(); f.lease.begin();
  const failed = expect(f.wait()).rejects.toThrow("host_observations_already_owned");
  await vi.advanceTimersByTimeAsync(2_000); await failed;
  expect(vi.getTimerCount()).toBe(0);
  const complete = vi.fn(), pending = f.wait().then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  f.lease.confirmReleased(); await pending;
  expect(vi.getTimerCount()).toBe(0);
});

test("late confirmation from a previous lease cannot clear its replacement's shutdown", async () => {
  const f = fixture(); f.lease.begin(); f.lease.confirmReleased();
  const next = createNativeObservationShutdown(f.root, f.owner); next.begin();
  f.lease.begin(); f.lease.confirmReleased();
  const complete = vi.fn(), pending = f.wait().then(complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  next.confirmReleased(); await pending;
});

test("an already aborted replacement never waits", async () => {
  const f = fixture(); f.abort.abort(new Error("replacement_cancelled"));
  await expect(f.wait()).rejects.toThrow("replacement_cancelled");
});
