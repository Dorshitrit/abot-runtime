import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type { NativeHostConnection } from "../../../plugins/system/source/companion/native-state.js";

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
}));
vi.mock("../../../plugins/system/source/companion/native-state.js", () => ({
  createNativeHostState: () => mocks.state,
}));
vi.mock("../../../plugins/system/source/companion/native-session.js", () => ({
  connectNativeHost: mocks.connect,
}));
vi.mock("../../../plugins/system/source/companion/autostart.js", () => ({
  installNativeAutostart: mocks.install,
  nativeAutostartFile: vi.fn(),
  uninstallNativeAutostart: vi.fn(),
}));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: mocks.question,
    close: mocks.closePrompt,
  }),
}));
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
