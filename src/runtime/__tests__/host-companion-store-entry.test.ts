import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import type { runHostCompanionCli } from "../../cli/host-companion.js";
import { runWindowsCompanionStoreEntry } from "../../cli/windows-companion-store-entry.js";
import type {
  NativeHostConnection,
  NativeHostState,
} from "../../computer-access/companion/native-state.js";
import {
  createStoreConnectionLink,
  STORE_CONNECTION_LINK_MAX_BYTES,
} from "../../computer-access/companion/windows-store/connection-link.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";
import {
  MissingStoreConnectionError,
  serializeStoreConnectionError,
} from "../../computer-access/companion/windows-store/connection-error.js";

const hostId = "317ec6e1-1148-47c7-85a2-dd6acac9fbe2";
const saved: NativeHostConnection = {
  version: 1,
  url: "ws://abot.localhost:5190",
  hostId,
  credential: "saved-credential-private-value".padEnd(43, "a"),
};
const invitation = {
  version: 1 as const,
  url: "http://127.0.0.1:5177",
  code: "pairing-secret-value".padEnd(43, "a"),
  expiresAt: "2099-10-08T12:15:00.000Z",
  companionRelease: COMPANION_RELEASE_VERSION,
};
const cliPath = "/fixture/store-companion.mjs";
function fixture(connection?: NativeHostConnection) {
  const state: NativeHostState = {
    directory: "/fixture/private-state",
    read: vi.fn(async () => connection),
    write: vi.fn(),
    remove: vi.fn(),
    setStatus: vi.fn(),
    isConnected: vi.fn(),
  };
  const createState = vi.fn(() => state);
  const runCli = vi.fn<typeof runHostCompanionCli>(async () => {});
  return { state, createState, runCli, cliPath };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("inspection shows the existing paired origin selected by host identity and never grants connection consent", async () => {
  const f = fixture(saved);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const link = createStoreConnectionLink({
    ...invitation,
    upgradeHostId: hostId,
  });
  await runWindowsCompanionStoreEntry(["inspect-link"], {
    ...f,
    input: Readable.from([link]),
  });
  expect(log).toHaveBeenCalledOnce();
  const preview = JSON.parse(log.mock.calls[0]![0]);
  expect(preview).toEqual({
    runtimeUrl: "http://abot.localhost:5190",
    paired: true,
    existingRuntimeUrl: "http://abot.localhost:5190",
    expiresAt: invitation.expiresAt,
  });
  expect(JSON.stringify(preview)).not.toContain(invitation.code);
  expect(JSON.stringify(preview)).not.toContain(saved.credential);
  expect(f.runCli).not.toHaveBeenCalled();
  expect(f.state.write).not.toHaveBeenCalled();
  expect(f.state.remove).not.toHaveBeenCalled();
});

test("new-connection inspection uses the requested origin and has no stored-state mutation", async () => {
  const f = fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runWindowsCompanionStoreEntry(["inspect-link"], {
    ...f,
    input: Readable.from([createStoreConnectionLink(invitation)]),
  });
  expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
    runtimeUrl: invitation.url,
    expiresAt: invitation.expiresAt,
    paired: false,
  });
  expect(f.runCli).not.toHaveBeenCalled();
  expect(f.state.write).not.toHaveBeenCalled();
});

test("setup delegates a bounded stdin invitation to the shared CLI with its exact upgrade identity", async () => {
  const f = fixture(saved);
  const link = createStoreConnectionLink({
    ...invitation,
    upgradeHostId: hostId,
  });
  await runWindowsCompanionStoreEntry(["setup-link"], {
    ...f,
    input: Readable.from([link.slice(0, 50), link.slice(50)]),
  });
  expect(f.runCli).toHaveBeenCalledWith(["connect", "--url", invitation.url], {
    cliPath,
    pairingCode: invitation.code,
    upgradeHostId: hostId,
    lifecycle: expect.objectContaining({
      assertStartupSupported: expect.any(Function),
      completeStartup: expect.any(Function),
      uninstall: expect.any(Function),
      createNotifications: expect.any(Function),
    }),
  });
  expect(f.state.write).not.toHaveBeenCalled();
});

test.each([
  undefined,
  { ...saved, hostId: "317ec6e1-1148-47c7-85a2-dd6acac9fbe3" },
  { ...saved, url: "ws://192.168.1.2:5177" },
])(
  "inspection rejects an unbound or nonlocal saved upgrade target %# before dispatch",
  async (connection) => {
    const f = fixture(connection);
    await expect(
      runWindowsCompanionStoreEntry(["inspect-link"], {
        ...f,
        input: Readable.from([
          createStoreConnectionLink({ ...invitation, upgradeHostId: hostId }),
        ]),
      }),
    ).rejects.toThrow();
    expect(f.runCli).not.toHaveBeenCalled();
  },
);

test("ordinary setup cannot silently replace another saved runtime", async () => {
  const f = fixture(saved);
  await expect(
    runWindowsCompanionStoreEntry(["setup-link"], {
      ...f,
      input: Readable.from([createStoreConnectionLink(invitation)]),
    }),
  ).rejects.toThrow("already paired");
  expect(f.runCli).not.toHaveBeenCalled();
});

test.each(["inspect-link", "setup-link"])(
  "%s reports missing local upgrade state with a safe typed code and no pairing mutation",
  async (command) => {
    const f = fixture();
    await expect(
      runWindowsCompanionStoreEntry([command], {
        ...f,
        input: Readable.from([
          createStoreConnectionLink({ ...invitation, upgradeHostId: hostId }),
        ]),
      }),
    ).rejects.toBeInstanceOf(MissingStoreConnectionError);
    expect(f.runCli).not.toHaveBeenCalled();
    expect(f.state.write).not.toHaveBeenCalled();
    expect(f.state.remove).not.toHaveBeenCalled();
  },
);

test("Store helper error serialization uses only fixed codes, never arbitrary error or invitation content", () => {
  expect(JSON.parse(serializeStoreConnectionError(new MissingStoreConnectionError())))
    .toEqual({ error: "companion_local_pairing_missing" });
  const invitationText = createStoreConnectionLink(invitation);
  for (const error of [
    new Error(invitationText),
    invitationText,
    { error: "companion_local_pairing_missing", secret: invitation.code },
    new Error("companion_local_pairing_missing"),
  ]) {
    expect(JSON.parse(serializeStoreConnectionError(error)))
      .toEqual({ error: "companion_request_failed" });
  }
});

test.each(["run", "status", "disconnect", "uninstall", "--help"])(
  "host %s delegates to the same CLI with Store lifecycle",
  async (command) => {
    const f = fixture();
    await runWindowsCompanionStoreEntry(["host", command], f);
    expect(f.runCli).toHaveBeenCalledWith([command], {
      cliPath,
      lifecycle: expect.objectContaining({
        completeStartup: expect.any(Function),
      }),
    });
    expect(f.createState).not.toHaveBeenCalled();
  },
);

test("plugin links keep the existing shared open-link validation path", async () => {
  const f = fixture();
  const link = "abot://install?fixture=untrusted-input";
  await runWindowsCompanionStoreEntry(["open-plugin-link"], {
    ...f,
    input: Readable.from([link]),
  });
  expect(f.runCli).toHaveBeenCalledWith(
    ["open-link", link],
    expect.objectContaining({ cliPath }),
  );
  expect(f.createState).not.toHaveBeenCalled();
});

test.each([
  {
    args: ["setup-link", invitation.code],
    error: "Companion links must be sent on standard input.",
  },
  { args: ["host", "connect"], error: "Unsupported Companion command." },
  { args: ["host", "run", "extra"], error: "Unsupported Companion command." },
  { args: ["unknown"], error: "Unsupported Companion command." },
])(
  "rejects unsupported arguments %# without echoing activation secrets",
  async ({ args, error }) => {
    const f = fixture();
    let message = "";
    await runWindowsCompanionStoreEntry(args, f).catch((error: Error) => {
      message = error.message;
    });
    expect(message).toBe(error);
    expect(message).not.toContain(invitation.code);
    expect(f.runCli).not.toHaveBeenCalled();
  },
);

test("oversized stdin cannot reach state inspection or CLI dispatch", async () => {
  const f = fixture();
  await expect(
    runWindowsCompanionStoreEntry(["setup-link"], {
      ...f,
      input: Readable.from(["a".repeat(STORE_CONNECTION_LINK_MAX_BYTES), "x"]),
    }),
  ).rejects.toThrow("size limit");
  expect(f.createState).not.toHaveBeenCalled();
  expect(f.runCli).not.toHaveBeenCalled();
});

test("an unclosed Store stdin is bounded by the shared input timeout", async () => {
  vi.useFakeTimers();
  const input = new PassThrough();
  const f = fixture();
  const result = expect(
    runWindowsCompanionStoreEntry(["inspect-link"], { ...f, input }),
  ).rejects.toThrow("timed out");
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
  } finally {
    input.destroy();
  }
  expect(f.runCli).not.toHaveBeenCalled();
});

test("fresh same-origin Store setup delegates the new grant despite stale local pairing", async () => {
  const f = fixture({ ...saved, url: "ws://127.0.0.1:5177" });
  await runWindowsCompanionStoreEntry(["setup-link"], {
    ...f, input: Readable.from([createStoreConnectionLink(invitation)]),
  });
  expect(f.runCli).toHaveBeenCalledWith(["connect", "--url", invitation.url],
    expect.objectContaining({ pairingCode: invitation.code, pairingMode: "fresh-grant" }));
  expect(f.runCli.mock.calls[0]![1]).not.toHaveProperty("upgradeHostId");
  expect(f.state.remove).not.toHaveBeenCalled();
});
