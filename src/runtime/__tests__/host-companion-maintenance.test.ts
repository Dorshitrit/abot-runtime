vi.mock("../../computer-access/companion/native-notifications.js", () => ({
  createNativeNotificationSession: vi.fn(async () => ({ ready: false, handlers: () => ({}), close: () => {} })),
}));
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { runNativeHostSupervisor } from "../../computer-access/companion/native-supervisor.js";
import {
  NATIVE_STATUS_INTERVAL_MS,
  type NativeHostState,
} from "../../computer-access/companion/native-state.js";
import type { NativeSessionOptions } from "../../computer-access/companion/native-session.js";

afterEach(() => vi.useRealTimers());

test("idle companion maintains status sparsely and reacts immediately to connection changes", async () => {
  vi.useFakeTimers();
  let saved: Awaited<ReturnType<NativeHostState["read"]>> = {
    version: 1,
    url: "ws://localhost:5184",
    hostId: randomUUID(),
    credential: "a".repeat(43),
  };
  let changed!: () => void;
  const unwatch = vi.fn();
  const state: NativeHostState = {
    directory: "/test",
    read: vi.fn(async () => saved),
    write: vi.fn(),
    remove: vi.fn(),
    setStatus: vi.fn(),
    isConnected: vi.fn(),
    watch: (listener) => {
      changed = listener;
      return unwatch;
    },
  };
  const stop = new AbortController();
  const running = runNativeHostSupervisor({
    state,
    identity: {
      name: "test",
      os: "windows",
      user: "test",
      homeDir: "C:\\test",
    },
    signal: stop.signal,
    connect: async (options: NativeSessionOptions) => {
      await options.onReady(saved!.hostId);
      return new Promise((resolve) =>
        options.signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        }),
      );
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.read).toHaveBeenCalledTimes(2);
  expect(state.setStatus).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS - 1);
  expect(state.read).toHaveBeenCalledTimes(2);
  expect(state.setStatus).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.read).toHaveBeenCalledTimes(3);
  expect(state.setStatus).toHaveBeenCalledTimes(2);
  // A watcher notification without a connection change must not cause another
  // status write (some filesystems do not identify the changed filename).
  changed();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.setStatus).toHaveBeenCalledTimes(2);
  saved = undefined;
  changed();
  await running;
  expect(unwatch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["read", "status"])(
  "queues a disconnect notification during a pending %s",
  async (phase) => {
    vi.useFakeTimers();
    const initial = {
      version: 1 as const,
      url: "ws://localhost:5184",
      hostId: randomUUID(),
      credential: "a".repeat(43),
    };
    let saved: typeof initial | undefined = initial;
    let changed!: () => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async () => saved);
    const setStatus = vi.fn(async () => {});
    const state: NativeHostState = {
      directory: "/test",
      read,
      setStatus,
      write: vi.fn(),
      remove: vi.fn(),
      isConnected: vi.fn(),
      watch: (listener) => {
        changed = listener;
        return vi.fn();
      },
    };
    const stop = new AbortController();
    const running = runNativeHostSupervisor({
      state,
      identity: {
        name: "test",
        os: "windows",
        user: "test",
        homeDir: "C:\\test",
      },
      signal: stop.signal,
      connect: async (options) => {
        await options.onReady(initial.hostId);
        return new Promise((resolve) =>
          options.signal.addEventListener("abort", () => resolve("stopped"), {
            once: true,
          }),
        );
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "read")
        read.mockImplementationOnce(async () => {
          await pending;
          return initial;
        });
      else setStatus.mockImplementationOnce(() => pending);
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      saved = undefined;
      changed();
      changed();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(4);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      stop.abort();
      await running;
    }
  },
);
