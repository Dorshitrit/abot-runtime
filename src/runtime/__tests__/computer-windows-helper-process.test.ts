import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { runWindowsComputerHelper, WINDOWS_HELPER_MAX_BYTES } from "../../computer-access/computer/windows-helper-process.js";

function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
  });
}
function setup() {
  const child = fakeProcess();
  const spawnProcess = vi.fn<typeof spawn>().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return { child, spawnProcess };
}
afterEach(() => vi.useRealTimers());

test("native source and request use stdin rather than command-line interpolation", async () => {
  const { child, spawnProcess } = setup();
  const source = "source with `$() and ' quotes";
  const pending = runWindowsComputerHelper({ executable: "powershell.exe", source, request: { operation: "inspect" }, spawnProcess: spawnProcess as unknown as typeof spawn });
  child.emit("spawn"); child.stdout.emit("data", Buffer.from('{"desktop":')); child.stdout.emit("data", Buffer.from('"bounded"}'));
  child.emit("close", 0);
  expect(await pending).toEqual({ status: "completed", spawned: true, stdout: '{"desktop":"bounded"}', exitCode: 0 });
  const payload = JSON.parse(child.stdin.end.mock.calls[0]?.[0] as string);
  expect(payload).toEqual({ source, request: '{"operation":"inspect"}' });
  expect(spawnProcess.mock.calls[0]?.[1]).not.toContain(source);
  expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
});

test("an already aborted call cannot create a native process", async () => {
  const { spawnProcess } = setup();
  const result = await runWindowsComputerHelper({ executable: "powershell.exe", source: "", request: { operation: "inspect" }, signal: AbortSignal.abort(), spawnProcess: spawnProcess as unknown as typeof spawn });
  expect(result).toEqual({ status: "aborted", stdout: "", spawned: false });
  expect(spawnProcess).not.toHaveBeenCalled();
});

test("bounded output overflow kills the helper and discards its incomplete receipt", async () => {
  const { child, spawnProcess } = setup();
  const pending = runWindowsComputerHelper({ executable: "powershell.exe", source: "", request: { operation: "inspect" }, spawnProcess: spawnProcess as unknown as typeof spawn });
  child.emit("spawn"); child.stdout.emit("data", Buffer.alloc(WINDOWS_HELPER_MAX_BYTES + 1)); child.emit("close", null);
  expect(await pending).toMatchObject({ status: "output_limit", spawned: true, stdout: "" });
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

test("cancellation settles without claiming a WSL native process stopped", async () => {
  vi.useFakeTimers();
  const { child, spawnProcess } = setup();
  const controller = new AbortController();
  const pending = runWindowsComputerHelper({ executable: "powershell.exe", source: "", request: { operation: "inspect" }, signal: controller.signal, spawnProcess: spawnProcess as unknown as typeof spawn });
  child.emit("spawn"); controller.abort();
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toEqual({ status: "aborted", spawned: true, stdout: "" });
  expect(spawnProcess).toHaveBeenCalledOnce();
  expect(child.kill).toHaveBeenCalledOnce();
});

test("a synchronous spawn failure has no native execution receipt", async () => {
  const spawnProcess = vi.fn<typeof spawn>().mockImplementation(() => { throw new Error("missing executable"); });
  const result = await runWindowsComputerHelper({ executable: "missing", source: "", request: { operation: "inspect" }, spawnProcess: spawnProcess as unknown as typeof spawn });
  expect(result).toEqual({ status: "spawn_failed", spawned: false, stdout: "" });
});
