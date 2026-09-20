import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { resolveNativeRuntimeAddress } from "../../../plugins/system/source/companion/native-address.js";
import { runNativeHostSupervisor } from "../../../plugins/system/source/companion/native-supervisor.js";
import type {
  NativeSessionOptions,
  NativeSessionOutcome,
} from "../../../plugins/system/source/companion/native-session.js";
import type {
  NativeHostConnection,
  NativeHostState,
} from "../../../plugins/system/source/companion/native-state.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const saved: NativeHostConnection = {
    version: 1,
    url: "ws://runtime.example.test:5184",
    hostId: randomUUID(),
    credential: "a".repeat(43),
  };
  const state: NativeHostState = {
    directory: "/fixture/native-state",
    read: vi.fn(async () => saved),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    isConnected: vi.fn(async () => false),
  };
  const identity = {
    name: "fixture",
    os: "windows" as const,
    user: "test",
    homeDir: "C:\\Users\\test",
  };
  const stop = new AbortController();
  const connect =
    vi.fn<(options: NativeSessionOptions) => Promise<NativeSessionOutcome>>();
  return { saved, state, identity, stop, connect };
}

test.each(["EAI_AGAIN", "ENOTFOUND"])(
  "backs off after %s without replacing or replaying the saved connection",
  async (code) => {
    vi.useFakeTimers();
    const f = fixture();
    f.connect
      .mockImplementationOnce(async (options) => {
        await resolveNativeRuntimeAddress(options.url, async () => {
          throw Object.assign(new Error("lookup unavailable"), {
            code,
            syscall: "getaddrinfo",
          });
        });
        return "disconnected";
      })
      .mockImplementationOnce(async (options) => {
        expect(options.authorization).toBe(f.saved.credential);
        expect(options.hostId).toBe(f.saved.hostId);
        await options.onReady(f.saved.hostId);
        f.stop.abort();
        return "stopped";
      });
    const running = runNativeHostSupervisor({
      ...f,
      signal: f.stop.signal,
      reconnectDelayMs: 20,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(19);
    expect(f.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.state.write).not.toHaveBeenCalled();
    expect(f.state.remove).not.toHaveBeenCalled();
  },
);

test("cancellation interrupts lookup backoff without another connection attempt", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.connect.mockRejectedValue(
    Object.assign(new Error("lookup unavailable"), { code: "EAI_AGAIN" }),
  );
  const running = runNativeHostSupervisor({ ...f, signal: f.stop.signal });
  await vi.advanceTimersByTimeAsync(0);
  f.stop.abort();
  await running;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.state.remove).not.toHaveBeenCalled();
});

test("non-loopback address policy rejection stays terminal", async () => {
  const f = fixture();
  f.connect.mockImplementation(async (options) => {
    await resolveNativeRuntimeAddress(options.url, async () => [
      { address: "203.0.113.2", family: 4 },
    ]);
    return "disconnected";
  });
  await expect(
    runNativeHostSupervisor({ ...f, signal: f.stop.signal }),
  ).rejects.toThrow("loopback interface");
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.state.remove).not.toHaveBeenCalled();
});

test("unexpected setup errors are not retried as network loss", async () => {
  const f = fixture();
  const error = Object.assign(new Error("invalid saved configuration"), {
    code: "ERR_INVALID_URL",
  });
  f.connect.mockRejectedValue(error);
  await expect(
    runNativeHostSupervisor({ ...f, signal: f.stop.signal }),
  ).rejects.toBe(error);
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.state.remove).not.toHaveBeenCalled();
});
