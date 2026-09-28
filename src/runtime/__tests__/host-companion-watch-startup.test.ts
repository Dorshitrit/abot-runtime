vi.mock("../../computer-access/companion/native-notifications.js", () => ({
  createNativeNotificationSession: vi.fn(async () => ({ ready: false, handlers: () => ({}), close: () => {} })),
}));
import { watch } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import {
  createNativeHostState,
  NATIVE_STATUS_INTERVAL_MS,
  type NativeHostConnection,
  type NativeHostState,
} from "../../computer-access/companion/native-state.js";
import { runNativeHostSupervisor } from "../../computer-access/companion/native-supervisor.js";
import type { NativeSessionOptions } from "../../computer-access/companion/native-session.js";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function fixture() {
  let saved: NativeHostConnection | undefined = {
    version: 1,
    url: "ws://localhost:5184",
    hostId: "watch-test",
    credential: "a".repeat(43),
  };
  const state: NativeHostState = {
    ...createNativeHostState("/fixture", {
      ensureDirectory: vi.fn(),
      assertFile: vi.fn(),
    }),
    read: vi.fn(async () => saved),
    setStatus: vi.fn(),
  };
  const stop = new AbortController();
  const connect = vi.fn(async (options: NativeSessionOptions) => {
    await options.onReady(saved!.hostId);
    return new Promise<"stopped">((resolve) => {
      options.signal.addEventListener("abort", () => resolve("stopped"), {
        once: true,
      });
    });
  });
  return {
    state,
    connect,
    stop,
    changeSaved: (replacement?: NativeHostConnection) => {
      saved = replacement;
    },
    start: () =>
      runNativeHostSupervisor({
        state,
        connect,
        signal: stop.signal,
        identity: { name: "test", os: "linux", user: "test", homeDir: "/test" },
      }),
  };
}

test.each(["removed", "replaced"])(
  "does not connect when pairing is %s before the watcher is registered",
  async (change) => {
    vi.useFakeTimers();
    const f = fixture();
    const unwatch = vi.fn();
    f.state.watch = () => {
      f.changeSaved(
        change === "removed"
          ? undefined
          : {
              version: 1,
              url: "ws://localhost:5184",
              hostId: "replacement",
              credential: "b".repeat(43),
            },
      );
      return unwatch;
    };
    const running = f.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.connect).not.toHaveBeenCalled();
      expect(unwatch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.stop.abort();
      await running;
    }
  },
);

test.each(["ENOSPC", "ENOSYS"])(
  "keeps the companion connected and checks state periodically when watch throws %s",
  async (code) => {
    vi.useFakeTimers();
    vi.mocked(watch).mockImplementationOnce(() => {
      throw Object.assign(new Error("watch unavailable"), { code });
    });
    const f = fixture();
    const running = f.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.state.setStatus).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS - 1);
      expect(f.state.setStatus).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.state.setStatus).toHaveBeenCalledTimes(2);
      f.changeSaved();
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      expect(watch).toHaveBeenCalledOnce();
      expect(f.connect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.stop.abort();
      await running;
    }
  },
);
