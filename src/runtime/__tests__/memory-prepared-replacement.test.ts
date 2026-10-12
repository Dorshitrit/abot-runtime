import { rename } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { replacePreparedMemoryFile } from "../../../plugins/memory/source/prepared-memory-replacement.js";

vi.mock("node:fs/promises", () => ({ rename: vi.fn() }));
const publish = vi.mocked(rename);
const temporary = "memory.json.prepared.tmp";
const target = "memory.json";
function denial(code = "EPERM") { return Object.assign(new Error(`fixture_${code}`), { code }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.spyOn(performance, "now").mockReturnValue(0);
  publish.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("successful publication performs exactly one rename without a timer", async () => {
  publish.mockResolvedValue(undefined);
  await replacePreparedMemoryFile(temporary, target);
  expect(publish).toHaveBeenCalledExactlyOnceWith(temporary, target);
  expect(vi.getTimerCount()).toBe(0);
});

test("Windows replacement contention keeps the same prepared bytes and destination", async () => {
  publish.mockRejectedValueOnce(denial()).mockRejectedValueOnce(denial()).mockResolvedValueOnce(undefined);
  const pending = replacePreparedMemoryFile(temporary, target);
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(publish.mock.calls).toEqual(Array(3).fill([temporary, target]));
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["linux", "darwin"])("%s retains immediate failure semantics", async (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  const error = denial(); publish.mockRejectedValue(error);
  await expect(replacePreparedMemoryFile(temporary, target)).rejects.toBe(error);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["EBUSY", "EACCES", "ENOENT", "EIO"])("Windows %s is never retried", async (code) => {
  const error = denial(code); publish.mockRejectedValue(error);
  await expect(replacePreparedMemoryFile(temporary, target)).rejects.toBe(error);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("late timer delivery cannot start another rename beyond one second", async () => {
  const error = denial(); publish.mockRejectedValue(error);
  const settled = replacePreparedMemoryFile(temporary, target).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(performance.now).mockReturnValue(1_001);
  await vi.advanceTimersByTimeAsync(25);
  expect(await settled).toBe(error);
  expect(publish).toHaveBeenCalledTimes(1);
});

test("a stalled clock still reaches the attempt cap and preserves the latest error", async () => {
  let lastError: Error;
  publish.mockImplementation(async () => { lastError = denial(); throw lastError; });
  const settled = replacePreparedMemoryFile(temporary, target).catch(error => error);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await settled).toBe(lastError!);
  expect(publish).toHaveBeenCalledTimes(41);
  expect(vi.getTimerCount()).toBe(0);
});

test("later permanent errors propagate unchanged without another wait", async () => {
  const permanent = denial("EACCES");
  publish.mockRejectedValueOnce(denial()).mockRejectedValueOnce(permanent);
  const settled = replacePreparedMemoryFile(temporary, target).catch(error => error);
  await vi.advanceTimersByTimeAsync(25);
  expect(await settled).toBe(permanent);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("in-flight replacement is awaited so a late success cannot become a reported failure", async () => {
  let finish!: () => void;
  publish.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const settled = vi.fn();
  const pending = replacePreparedMemoryFile(temporary, target).then(settled);
  vi.mocked(performance.now).mockReturnValue(2_000);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(settled).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledTimes(1);
  finish(); await pending;
  expect(settled).toHaveBeenCalledTimes(1);
});
