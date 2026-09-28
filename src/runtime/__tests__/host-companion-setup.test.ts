import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NativeAutostartOptions } from "../../computer-access/companion/autostart.js";
import type { NativeHostConnection } from "../../computer-access/companion/native-state.js";

vi.mock(
  "../../computer-access/companion/native-runtime-installation.js",
  () => ({
    prepareNativeCompanionRuntime: async (startup: NativeAutostartOptions) =>
      startup,
  }),
);
vi.mock("../../computer-access/companion/notification-installation.js", () => ({
  installDesktopNotificationIdentity: vi.fn(async () => {}),
  uninstallDesktopNotificationIdentity: vi.fn(async () => {}),
}));
const mocks = vi.hoisted(() => ({
  state: {
    directory: "/fixture/private-host",
    read: vi.fn<() => Promise<NativeHostConnection | undefined>>(),
    write: vi.fn<(connection: NativeHostConnection) => Promise<void>>(),
    isConnected: vi.fn(async () => true),
  },
  question: vi.fn(async () => "b".repeat(43)),
  closePrompt: vi.fn(),
  connect: vi.fn(),
  install: vi.fn(async (_options: { cliPath: string }) => ({ started: true })),
  stopOwned: vi.fn(async () => {}),
  inspectRegistration: vi.fn(async () => false),
}));
vi.mock("../../computer-access/companion/native-build-identity.js", () => ({
  readNativeCompanionBuildId: vi.fn(async () => "current-build"),
}));
vi.mock("../../computer-access/companion/native-replacement.js", () => ({
  stopOwnedNativeCompanion: mocks.stopOwned,
}));
vi.mock("../../computer-access/companion/native-state.js", () => ({
  createNativeHostState: () => mocks.state,
}));
vi.mock("../../computer-access/companion/native-session.js", () => ({
  connectNativeHost: mocks.connect,
}));
vi.mock("../../computer-access/companion/autostart.js", () => ({
  installNativeAutostart: mocks.install,
  nativeAutostartFile: vi.fn(),
  uninstallNativeAutostart: vi.fn(),
  existingOwnedRegistration: mocks.inspectRegistration,
}));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: mocks.question,
    close: mocks.closePrompt,
  }),
}));
import { installDesktopNotificationIdentity } from "../../computer-access/companion/notification-installation.js";
import { runHostCompanionCli } from "../../cli/host-companion.js";

beforeEach(() => {
  vi.resetAllMocks();
  let saved: NativeHostConnection | undefined;
  mocks.state.read.mockImplementation(async () => saved);
  mocks.state.write.mockImplementation(async (connection) => {
    saved = connection;
  });
  mocks.state.isConnected.mockResolvedValue(true);
  mocks.question.mockResolvedValue("b".repeat(43));
  mocks.install.mockResolvedValue({ started: true });
  mocks.connect.mockImplementation(async (options) => {
    await options.onPaired(randomUUID(), "c".repeat(43));
    return "disconnected";
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("CLI forwards the effective XDG config home to startup registration", async () => {
  vi.stubEnv("XDG_CONFIG_HOME", "/fixture/custom-config");
  await runHostCompanionCli(
    ["connect", "--url", "http://abot.localhost:5184"],
    {
      pairingCode: "a".repeat(43),
    },
  );
  expect(mocks.install).toHaveBeenCalledWith(
    expect.objectContaining({ xdgConfigHome: "/fixture/custom-config" }),
  );
});

test("installer setup reuses pairing and registers the supplied stable bundle", async () => {
  const cliPath = "/fixture/native/host-companion-bundle.mjs";
  await runHostCompanionCli(
    ["connect", "--url", "http://abot.localhost:5184"],
    {
      cliPath,
      pairingCode: "a".repeat(43),
    },
  );
  expect(mocks.question).not.toHaveBeenCalled();
  expect(mocks.connect.mock.calls[0]![0].authorization).toBe("a".repeat(43));
  expect(mocks.install).toHaveBeenCalledWith(
    expect.objectContaining({ cliPath }),
  );
  expect(mocks.state.write).toHaveBeenCalledOnce();
  expect(mocks.stopOwned).toHaveBeenCalledWith(mocks.state.directory);
  expect(mocks.stopOwned.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.install.mock.invocationCallOrder[0]!,
  );
  expect(mocks.state.isConnected).toHaveBeenCalledWith(
    expect.any(String),
    "current-build",
    expect.any(Number),
  );
});
test("ordinary CLI connect retains interactive input and the packaged bin path", async () => {
  await runHostCompanionCli(["connect", "--url", "http://abot.localhost:5184"]);
  expect(mocks.question).toHaveBeenCalledOnce();
  expect(mocks.closePrompt).toHaveBeenCalledOnce();
  expect(mocks.connect.mock.calls[0]![0].authorization).toBe("b".repeat(43));
  const startup = mocks.install.mock.calls[0]![0];
  expect(basename(startup.cliPath)).toBe("bin.js");
});

test("retries failed startup with the same saved pairing and no second code exchange", async () => {
  const options = {
    cliPath: "/fixture/native/companion.mjs",
    pairingCode: "a".repeat(43),
  };
  mocks.install.mockRejectedValueOnce(new Error("startup denied"));
  await expect(
    runHostCompanionCli(
      ["connect", "--url", "http://abot.localhost:5184"],
      options,
    ),
  ).rejects.toThrow("startup denied");
  const saved = await mocks.state.read();
  expect(saved).toMatchObject({ url: "ws://abot.localhost:5184" });
  await runHostCompanionCli(["connect", "--url", "ws://abot.localhost:5184"], {
    cliPath: options.cliPath,
  });
  expect(await mocks.state.read()).toEqual(saved);
  expect(mocks.state.write).toHaveBeenCalledOnce();
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(mocks.question).not.toHaveBeenCalled();
  expect(mocks.install).toHaveBeenCalledTimes(2);
  expect(mocks.install.mock.calls[1]![0].cliPath).toBe(options.cliPath);
});

test("refuses to resume startup for a different Runtime without changing saved ownership", async () => {
  const saved: NativeHostConnection = {
    version: 1,
    url: "ws://abot.localhost:5184",
    hostId: randomUUID(),
    credential: "a".repeat(43),
  };
  mocks.state.read.mockResolvedValue(saved);
  await expect(
    runHostCompanionCli(["connect", "--url", "http://abot.localhost:5185"]),
  ).rejects.toThrow("already paired");
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.state.write).not.toHaveBeenCalled();
  expect(mocks.question).not.toHaveBeenCalled();
  expect(await mocks.state.read()).toBe(saved);
});

test("resumed startup preserves rejection of unmanaged registration files", async () => {
  const saved: NativeHostConnection = {
    version: 1,
    url: "ws://abot.localhost:5184",
    hostId: randomUUID(),
    credential: "a".repeat(43),
  };
  mocks.state.read.mockResolvedValue(saved);
  mocks.install.mockRejectedValue(
    new Error("Refusing to replace unmanaged registration."),
  );
  await expect(
    runHostCompanionCli(["connect", "--url", "http://abot.localhost:5184"]),
  ).rejects.toThrow("unmanaged registration");
  expect(mocks.install).toHaveBeenCalledOnce();
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.state.write).not.toHaveBeenCalled();
  expect(await mocks.state.read()).toBe(saved);
});

test("setup waits for the current build instead of accepting an old heartbeat", async () => {
  vi.useFakeTimers();
  mocks.state.isConnected
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const pending = runHostCompanionCli([
    "connect",
    "--url",
    "http://abot.localhost:5184",
  ]);
  await vi.advanceTimersByTimeAsync(0);
  expect(log).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  await pending;
  expect(mocks.state.isConnected).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledOnce();
});

test("setup fails without a matching connected build while preserving the pairing", async () => {
  vi.useFakeTimers();
  mocks.state.isConnected.mockResolvedValue(false);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const pending = runHostCompanionCli([
    "connect",
    "--url",
    "http://abot.localhost:5184",
  ]);
  const rejected = expect(pending).rejects.toThrow(
    "updated host companion did not connect",
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(log).not.toHaveBeenCalled();
  expect(await mocks.state.read()).toBeDefined();
});

test("unsafe replacement or unmanaged startup never starts a second companion", async () => {
  mocks.inspectRegistration.mockRejectedValueOnce(
    new Error("unmanaged registration"),
  );
  await expect(
    runHostCompanionCli(["connect", "--url", "http://abot.localhost:5184"]),
  ).rejects.toThrow("unmanaged registration");
  expect(mocks.stopOwned).not.toHaveBeenCalled();
  mocks.stopOwned.mockRejectedValueOnce(new Error("unverified process owner"));
  await expect(
    runHostCompanionCli(["connect", "--url", "http://abot.localhost:5184"]),
  ).rejects.toThrow("unverified process owner");
  expect(mocks.install).not.toHaveBeenCalled();
  expect(await mocks.state.read()).toBeDefined();
});

test("notification setup failure preserves the existing computer connection and startup", async () => {
  vi.mocked(installDesktopNotificationIdentity).mockRejectedValueOnce(
    new Error("notify-send unavailable"),
  );
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runHostCompanionCli(
    ["connect", "--url", "http://abot.localhost:5184"],
    { pairingCode: "a".repeat(43) },
  );
  expect(mocks.install).toHaveBeenCalledOnce();
  expect(mocks.state.isConnected).toHaveBeenCalled();
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("notify-send unavailable"),
  );
});
