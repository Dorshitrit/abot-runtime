import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { ManagedLlamaLifecycle } from "./lifecycle.js";
import { LIMITS, type LaunchSettings, type Spawn, type Health } from "./contracts.js";
import type { InstalledLlama } from "./install.js";

class FakeChild extends EventEmitter {
  pid = 123456;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  confirm = true;
  kill = vi.fn((signal: NodeJS.Signals) => {
    if (this.confirm) this.exit(signal);
    return true;
  });
  exit(signal: NodeJS.Signals = "SIGTERM") { this.signalCode = signal; this.emit("exit", null, signal); }
}
const settings: LaunchSettings = { modelPath: "/synthetic/not-read.gguf", port: 18443, alias: "unit-model", contextTokens: 1024, gpuLayers: 0 };
const fixtures: ReturnType<typeof fixture>[] = [];
function fixture() {
  const child = new FakeChild();
  const outsider = new FakeChild();
  const spawn = vi.fn<Spawn>(() => child as unknown as ChildProcess);
  const health = vi.fn<Health>(async () => true);
  const validateLaunch = vi.fn(async (_input: unknown) => settings);
  // Only executable is consumed; this injected receipt never touches disk.
  const inspect = vi.fn(async (): Promise<InstalledLlama | null> => ({ executable: "/synthetic/bin/llama-server" } as InstalledLlama));
  const checkPort = vi.fn(async (_port: number, _signal: AbortSignal) => {});
  const manager = new ManagedLlamaLifecycle({ installer: { inspect }, spawn, health, validateLaunch, checkPort });
  return { child, outsider, spawn, health, validateLaunch, inspect, checkPort, manager };
}
function setup() { const f = fixture(); fixtures.push(f); return f; }
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.child.confirm = true;
    f.child.exit();
    await f.manager.close();
  }
  vi.useRealTimers();
});
test("ready start uses only injected seams and loopback argv; stop terminates only owned child", async () => {
  const f = setup();
  expect(f.manager.status()).toEqual({ phase: "idle", closed: false, ownsProcess: false });
  expect(f.inspect).not.toHaveBeenCalled();
  const connection = await f.manager.start(settings);
  expect(connection).toMatchObject({ baseUrl: "http://127.0.0.1:18443", model: "unit-model", contextWindowTokens: 1024 });
  expect(connection.apiKey).toMatch(/^[a-f0-9]{64}$/);
  expect(f.validateLaunch).toHaveBeenCalledWith(settings);
  expect(f.checkPort).toHaveBeenCalledWith(settings.port, expect.any(AbortSignal));
  expect(f.spawn).toHaveBeenCalledWith("/synthetic/bin/llama-server", ["--host", "127.0.0.1", "--port", "18443", "--model", settings.modelPath, "--alias", settings.alias, "--ctx-size", "1024", "--n-gpu-layers", "0"], expect.objectContaining({ shell: false, detached: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", LLAMA_API_KEY: connection.apiKey } }));
  expect(f.spawn.mock.calls[0][1]).not.toContain(connection.apiKey);
  expect(f.spawn.mock.calls[0][1]).not.toContain("--api-key");
  expect(f.health).toHaveBeenCalledWith(18443, connection.apiKey, settings.alias, expect.any(AbortSignal));
  expect(f.manager.readyConnection()).toEqual(connection);
  expect(f.manager.status()).not.toHaveProperty("apiKey");
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "busy" });
  await f.manager.stop();
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(f.outsider.kill).not.toHaveBeenCalled();
  expect(f.manager.readyConnection()).toBeNull();
  expect(f.manager.status()).toMatchObject({ phase: "stopped", ownsProcess: false });
});
test("concurrent start rejects without a second spawn", async () => {
  const f = setup();
  const first = f.manager.start(settings);
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "busy" });
  await first;
  expect(f.spawn).toHaveBeenCalledOnce();
});
test("port failure cannot spawn or check health", async () => {
  const f = setup();
  f.checkPort.mockRejectedValue(new Error("synthetic occupied port"));
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "port_unavailable" });
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.health).not.toHaveBeenCalled();
});
test("validation and missing installation fail before port or spawn", async () => {
  const f = setup();
  f.validateLaunch.mockRejectedValueOnce(new Error("synthetic invalid input"));
  await expect(f.manager.start({})).rejects.toMatchObject({ code: "invalid_launch" });
  expect(f.inspect).not.toHaveBeenCalled();
  f.inspect.mockResolvedValue(null);
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "not_installed" });
  expect(f.checkPort).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});
test("early child exit cannot be accepted as ready", async () => {
  const f = setup();
  f.health.mockImplementation(async () => { f.child.exit(); return true; });
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "child_exited" });
  expect(f.manager.readyConnection()).toBeNull();
  expect(f.manager.status().ownsProcess).toBe(false);
});
test("readiness deadline aborts an uncooperative health double and terminates child", async () => {
  vi.useFakeTimers();
  const f = setup();
  f.health.mockImplementation(() => new Promise<boolean>(() => {}));
  const result = f.manager.start(settings).catch(error => error);
  await flush(); expect(f.health).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(LIMITS.readyMs);
  expect(await result).toMatchObject({ code: "readiness_timeout" });
  expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(f.manager.status()).toMatchObject({ phase: "error", ownsProcess: false });
});
test("stop during start aborts health and clears ownership", async () => {
  const f = setup();
  f.health.mockImplementation(() => new Promise<boolean>(() => {}));
  const result = f.manager.start(settings).catch(error => error);
  await flush(); expect(f.health).toHaveBeenCalledOnce();
  const stopped = f.manager.stop();
  expect(f.manager.stop()).toBe(stopped);
  await stopped;
  expect(await result).toMatchObject({ code: "start_cancelled" });
  expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(f.manager.status()).toMatchObject({ phase: "stopped", ownsProcess: false });
});
test("close establishes permanent fence immediately, even during validation", async () => {
  const f = setup();
  f.validateLaunch.mockImplementation(() => new Promise<LaunchSettings>(() => {}));
  const started = f.manager.start(settings).catch(error => error);
  await flush();
  const closed = f.manager.close();
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "closed" });
  await closed;
  expect(await started).toMatchObject({ code: "start_cancelled" });
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.manager.status()).toMatchObject({ closed: true, ownsProcess: false });
});
test("unconfirmed termination retains ownership, blocks restart and allows cleanup retry", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.manager.start(settings);
  f.child.confirm = false;
  const stopped = f.manager.stop().catch(error => error);
  await vi.advanceTimersByTimeAsync(LIMITS.stopMs + LIMITS.killMs);
  expect(await stopped).toMatchObject({ code: "termination_unconfirmed" });
  expect(f.child.kill.mock.calls.map(call => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
  expect(f.manager.status()).toMatchObject({ phase: "error", ownsProcess: true, errorCode: "termination_unconfirmed" });
  expect(f.manager.readyConnection()).toBeNull();
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "busy" });
  const closed = f.manager.close().catch(error => error);
  await expect(f.manager.start(settings)).rejects.toMatchObject({ code: "closed" });
  await vi.advanceTimersByTimeAsync(LIMITS.stopMs + LIMITS.killMs);
  expect(await closed).toMatchObject({ code: "termination_unconfirmed" });
  expect(f.manager.status()).toMatchObject({ closed: true, ownsProcess: true });
  f.child.confirm = true;
  await f.manager.stop();
  expect(f.manager.status().ownsProcess).toBe(false);
  expect(f.outsider.kill).not.toHaveBeenCalled();
});
