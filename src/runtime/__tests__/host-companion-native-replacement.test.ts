import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  stopOwnedNativeCompanion,
  type NativeReplacementDependencies,
} from "../../computer-access/companion/native-replacement.js";
import type { DirectoryLockSnapshot } from "../adapters/long-term-memory/file-lock/contracts.js";

const owner: DirectoryLockSnapshot = {
  kind: "directory",
  modifiedAtMs: 0,
  hasLeaseDirectory: true,
  reclaimable: true,
  record: {
    pid: 1234,
    token: "376b4f28-c131-42ad-b169-1b8dff12e60f",
    createdAt: "2026-09-24T00:00:00Z",
    ownerIdentity: "os:boot:start",
  },
};

function fixture(platform: NodeJS.Platform = "linux") {
  let alive = true;
  let now = 0;
  const dependencies: NativeReplacementDependencies = {
    platform,
    currentPid: 5678,
    readLock: vi.fn(async () => owner),
    readIdentity: vi.fn(async () => "os:boot:start"),
    isAlive: vi.fn(async () => alive),
    signal: vi.fn(() => {
      alive = false;
    }),
    execute: vi.fn(async () => {
      alive = false;
    }),
    now: () => now,
    delay: vi.fn(async (ms) => {
      now += ms;
    }),
  };
  return {
    dependencies,
    stop: () => stopOwnedNativeCompanion("/private/companion", dependencies),
  };
}

describe("owned native companion replacement", () => {
  test("POSIX rechecks lock and process incarnation before SIGTERM and leaves storage alone", async () => {
    const f = fixture();
    await f.stop();
    expect(f.dependencies.readLock).toHaveBeenCalledTimes(2);
    expect(f.dependencies.readLock).toHaveBeenCalledWith(
      join("/private/companion", "agent"),
    );
    expect(f.dependencies.readIdentity).toHaveBeenCalledTimes(2);
    expect(f.dependencies.signal).toHaveBeenCalledExactlyOnceWith(
      1234,
      "SIGTERM",
    );
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(
      vi.mocked(f.dependencies.readIdentity).mock.invocationCallOrder[1],
    ).toBeLessThan(
      vi.mocked(f.dependencies.signal).mock.invocationCallOrder[0]!,
    );
  });

  test("Windows terminates only the verified companion tree with a hidden bounded taskkill", async () => {
    const f = fixture("win32");
    await f.stop();
    expect(f.dependencies.execute).toHaveBeenCalledExactlyOnceWith(
      "taskkill.exe",
      ["/PID", "1234", "/T", "/F"],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4096 },
    );
    expect(f.dependencies.signal).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "Windows replacement handles legacy boot-time drift while rejecting a recycled PID (%s)",
    async (recycled) => {
      const f = fixture("win32");
      vi.mocked(f.dependencies.readLock).mockResolvedValue({
        ...owner,
        record: {
          ...owner.record!,
          ownerIdentity: "windows:639234943810385860|639258367054633809",
        },
      });
      vi.mocked(f.dependencies.readIdentity).mockResolvedValue(
        recycled ? "windows:639258367054633810" : "windows:639258367054633809",
      );
      if (recycled) {
        await expect(f.stop()).rejects.toThrow("process identity changed");
        expect(f.dependencies.execute).not.toHaveBeenCalled();
        return;
      }
      await f.stop();
      expect(f.dependencies.readIdentity).toHaveBeenCalledTimes(2);
      expect(f.dependencies.execute).toHaveBeenCalledOnce();
      expect(f.dependencies.signal).not.toHaveBeenCalled();
    },
  );

  test.each(["absent", "dead"])(
    "an %s owner needs no signal",
    async (state) => {
      const f = fixture();
      if (state === "absent")
        vi.mocked(f.dependencies.readLock).mockResolvedValue(undefined);
      if (state === "dead")
        vi.mocked(f.dependencies.isAlive).mockResolvedValue(false);
      await f.stop();
      expect(f.dependencies.signal).not.toHaveBeenCalled();
      expect(f.dependencies.execute).not.toHaveBeenCalled();
    },
  );

  test("an incomplete reclaimable lock is left for canonical acquisition without touching a process", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.readLock).mockResolvedValue({
      ...owner,
      record: undefined,
    });
    await f.stop();
    expect(f.dependencies.readLock).toHaveBeenCalledOnce();
    expect(f.dependencies.isAlive).not.toHaveBeenCalled();
    expect(f.dependencies.readIdentity).not.toHaveBeenCalled();
    expect(f.dependencies.signal).not.toHaveBeenCalled();
    expect(f.dependencies.execute).not.toHaveBeenCalled();
  });

  test.each([undefined, "reused:pid"])(
    "unreadable or reused process identity never signals a PID (%s)",
    async (identity) => {
      const f = fixture();
      vi.mocked(f.dependencies.readIdentity).mockResolvedValue(identity);
      await expect(f.stop()).rejects.toThrow(/process identity/u);
      expect(f.dependencies.signal).not.toHaveBeenCalled();
    },
  );

  test("a legacy lock without an OS identity cannot authorize stopping a live process", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.readLock).mockResolvedValue({
      ...owner,
      record: { ...owner.record!, ownerIdentity: undefined },
    });
    await expect(f.stop()).rejects.toThrow("process identity unavailable");
    expect(f.dependencies.signal).not.toHaveBeenCalled();
  });

  test.each(["token", "identity", "unreadable"])(
    "a %s change immediately before signaling aborts replacement",
    async (change) => {
      const f = fixture();
      if (change === "token")
        vi.mocked(f.dependencies.readLock)
          .mockResolvedValueOnce(owner)
          .mockResolvedValue({
            ...owner,
            record: { ...owner.record!, token: "new-token" },
          });
      if (change === "identity")
        vi.mocked(f.dependencies.readIdentity)
          .mockResolvedValueOnce("os:boot:start")
          .mockResolvedValue("new:start");
      if (change === "unreadable")
        vi.mocked(f.dependencies.readIdentity)
          .mockResolvedValueOnce("os:boot:start")
          .mockResolvedValue(undefined);
      await expect(f.stop()).rejects.toThrow("safely replaced");
      expect(f.dependencies.signal).not.toHaveBeenCalled();
      expect(f.dependencies.execute).not.toHaveBeenCalled();
    },
  );

  test("ownership read errors and attempts to replace setup itself stop safely", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.readLock).mockRejectedValueOnce(
      new Error("unreadable"),
    );
    await expect(f.stop()).rejects.toThrow("ownership lock unreadable");
    await expect(
      stopOwnedNativeCompanion("/private/companion", {
        ...f.dependencies,
        currentPid: 1234,
      }),
    ).rejects.toThrow("setup owns");
    expect(f.dependencies.signal).not.toHaveBeenCalled();
  });

  test("an unresponsive process fails after the bounded wait without escalating its signal", async () => {
    const f = fixture();
    vi.mocked(f.dependencies.signal).mockImplementation(() => {});
    await expect(f.stop()).rejects.toThrow("process did not stop in time");
    expect(f.dependencies.signal).toHaveBeenCalledOnce();
    expect(f.dependencies.delay).toHaveBeenCalledTimes(100);
  });

  test("a stop failure never reports replacement success while the owner is alive", async () => {
    const f = fixture("win32");
    vi.mocked(f.dependencies.execute).mockRejectedValue(
      new Error("access denied"),
    );
    await expect(f.stop()).rejects.toThrow("process could not be stopped");
    expect(f.dependencies.signal).not.toHaveBeenCalled();
  });
});
