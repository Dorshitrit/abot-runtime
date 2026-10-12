import { rename } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { replacePreparedSessionFile } from "./prepared-session-replacement.js";

vi.mock("node:fs/promises", () => ({ rename: vi.fn() }));
const publish = vi.mocked(rename);
const temporary = "prepared-session.json.unique.tmp";
const target = "session.json";
function denial(code = "EPERM") { return Object.assign(new Error(`fixture_${code}`), { code }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.spyOn(performance, "now").mockReturnValue(0);
  publish.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("successful publication checks its guard and returns after exactly one rename", async () => {
  const calls: string[] = [];
  publish.mockImplementation(async () => { calls.push("rename"); });
  await replacePreparedSessionFile(temporary, target, () => { calls.push("guard"); });
  expect(calls).toEqual(["guard", "rename"]);
  expect(publish).toHaveBeenCalledExactlyOnceWith(temporary, target);
  expect(vi.getTimerCount()).toBe(0);
});

test("Windows contention retries the same prepared file and checks every attempt", async () => {
  const calls: string[] = [];
  publish.mockImplementationOnce(async () => { calls.push("denied"); throw denial(); })
    .mockImplementationOnce(async () => { calls.push("denied"); throw denial(); })
    .mockImplementationOnce(async () => { calls.push("published"); });
  const pending = replacePreparedSessionFile(temporary, target, () => { calls.push("guard"); });
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(calls).toEqual(["guard", "denied", "guard", "denied", "guard", "published"]);
  expect(publish.mock.calls).toEqual(Array(3).fill([temporary, target]));
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["linux", "darwin"])("%s propagates the initial denial without waiting", async (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  const error = denial(); publish.mockRejectedValue(error);
  await expect(replacePreparedSessionFile(temporary, target)).rejects.toBe(error);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["EBUSY", "EACCES", "ENOENT", "EIO"])("Windows %s is outside the replacement contention policy", async (code) => {
  const error = denial(code); publish.mockRejectedValue(error);
  await expect(replacePreparedSessionFile(temporary, target)).rejects.toBe(error);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a guard exception coded EPERM is never treated as rename contention", async () => {
  const error = denial();
  await expect(replacePreparedSessionFile(temporary, target, () => { throw error; })).rejects.toBe(error);
  expect(publish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["superseded", "EPERM"])("a stale %s guard after waiting prevents another filesystem attempt", async (cause) => {
  publish.mockRejectedValue(denial());
  const superseded = cause === "EPERM" ? denial() : new Error("proactive_superseded");
  const guard = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw superseded; });
  const settled = replacePreparedSessionFile(temporary, target, guard).catch(error => error);
  await vi.advanceTimersByTimeAsync(25);
  expect(await settled).toBe(superseded);
  expect(guard).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("late timer delivery cannot start a replacement after the monotonic deadline", async () => {
  const error = denial(); publish.mockRejectedValue(error);
  const settled = replacePreparedSessionFile(temporary, target).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(performance.now).mockReturnValue(1_001);
  await vi.advanceTimersByTimeAsync(25);
  expect(await settled).toBe(error);
  expect(publish).toHaveBeenCalledTimes(1);
});

test("attempt ceiling preserves the latest denial even if the clock does not advance", async () => {
  let lastError: Error;
  publish.mockImplementation(async () => { lastError = denial(); throw lastError; });
  const settled = replacePreparedSessionFile(temporary, target).catch(error => error);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await settled).toBe(lastError!);
  expect(publish).toHaveBeenCalledTimes(41);
  expect(vi.getTimerCount()).toBe(0);
});

test("an in-flight successful rename is awaited even when it finishes after the deadline", async () => {
  let finish!: () => void;
  publish.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const settled = vi.fn();
  const pending = replacePreparedSessionFile(temporary, target).then(settled);
  vi.mocked(performance.now).mockReturnValue(2_000);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(settled).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledTimes(1);
  finish(); await pending;
  expect(settled).toHaveBeenCalledTimes(1);
});

test("a later non-contention error is preserved without another wait", async () => {
  const permanent = denial("EACCES");
  publish.mockRejectedValueOnce(denial()).mockRejectedValueOnce(permanent);
  const settled = replacePreparedSessionFile(temporary, target).catch(error => error);
  await vi.advanceTimersByTimeAsync(25);
  expect(await settled).toBe(permanent);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
