import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NativeHostConnection } from "../../computer-access/companion/native-state.js";

vi.mock("../../computer-access/companion/notification-installation.js", () => ({
  installDesktopNotificationIdentity: vi.fn(async () => {}),
  uninstallDesktopNotificationIdentity: vi.fn(async () => {}),
}));
const mocks = vi.hoisted(() => ({
  state: {
    directory: "/fixture/private-host",
    read: vi.fn<() => Promise<NativeHostConnection | undefined>>(),
    write: vi.fn(),
    isConnected: vi.fn(async () => true),
  },
  connect: vi.fn(),
  install: vi.fn(async () => ({ started: true })),
  stopOwned: vi.fn(async () => {}),
}));
vi.mock(
  "../../computer-access/companion/native-state.js",
  async (load) => ({
    ...(await load<
      typeof import("../../computer-access/companion/native-state.js")
    >()),
    createNativeHostState: () => mocks.state,
  }),
);
vi.mock("../../computer-access/companion/native-session.js", () => ({
  connectNativeHost: mocks.connect,
}));
vi.mock(
  "../../computer-access/companion/native-build-identity.js",
  () => ({ readNativeCompanionBuildId: async () => "upgraded-build" }),
);
vi.mock(
  "../../computer-access/companion/native-replacement.js",
  () => ({ stopOwnedNativeCompanion: mocks.stopOwned }),
);
vi.mock("../../computer-access/companion/autostart.js", () => ({
  installNativeAutostart: mocks.install,
  nativeAutostartFile: vi.fn(),
  uninstallNativeAutostart: vi.fn(),
  existingOwnedRegistration: vi.fn(async () => false),
}));
vi.mock(
  "../../computer-access/companion/native-address.js",
  async (load) => {
    const original =
      await load<
        typeof import("../../computer-access/companion/native-address.js")
      >();
    return {
      ...original,
      resolveNativeRuntimeAddress: vi.fn(original.resolveNativeRuntimeAddress),
    };
  },
);

import { resolveNativeRuntimeAddress } from "../../computer-access/companion/native-address.js";
import { runHostCompanionEntry } from "../../cli/host-companion-entry.js";
import { runHostCompanionCli } from "../../cli/host-companion.js";
import { renderCompanionInstaller } from "../../web-ui/system-host-setup/installers.js";
import { COMPANION_NODE_VERSION } from "../../web-ui/system-host-setup/node-distribution.js";

const directories: string[] = [];
const bundleContent = "// inert cached companion fixture\n";
const saved: NativeHostConnection = {
  version: 1,
  url: "ws://localhost:5184",
  hostId: randomUUID(),
  credential: "c".repeat(43),
};
const installerInput = {
  url: "http://127.0.0.1:5184",
  code: "a".repeat(43),
  expiresAt: "2099-01-01T00:00:00.000Z",
  bundleSha256: createHash("sha256").update(bundleContent).digest("hex"),
  upgradeHostId: saved.hostId,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.read.mockResolvedValue(saved);
  mocks.install.mockResolvedValue({ started: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runCachedInstaller(platform: "macos" | "linux") {
  const home = await mkdtemp(join(tmpdir(), "abot-upgrade-origin-"));
  directories.push(home);
  const base =
    platform === "macos"
      ? join(home, "Library/Application Support/ABot/HostCompanion")
      : join(home, ".local/share/ABot/HostCompanion");
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const node =
    platform === "macos"
      ? join(
          base,
          `node-${COMPANION_NODE_VERSION}-darwin-${architecture}/bin/node`,
        )
      : join(home, "bin/node");
  const bundle = join(base, `companion-${installerInput.bundleSha256}.mjs`);
  const connection = join(home, ".abot/host-companion/connection.json");
  await Promise.all([
    mkdir(dirname(node), { recursive: true }),
    mkdir(base, { recursive: true }),
    mkdir(dirname(connection), { recursive: true }),
  ]);
  await writeFile(bundle, bundleContent);
  await writeFile(connection, JSON.stringify(saved));
  await writeFile(
    node,
    `#!/bin/bash
if [ "\${1:-}" = '--version' ]; then printf '%s\\n' '${COMPANION_NODE_VERSION}'; exit 0; fi
if [ "\${1:-}" = '-e' ]; then exit 0; fi
printf '%s\\n' "$@" > "$HOME/setup-arguments"
/bin/cat > "$HOME/setup-payload.json"
`,
    { mode: 0o700 },
  );
  const download = await renderCompanionInstaller({
    ...installerInput,
    platform,
  });
  const script =
    platform === "macos"
      ? await (await JSZip.loadAsync(download.contentBase64, { base64: true }))
          .file("ABot-Connect-Computer.command")!
          .async("string")
      : Buffer.from(download.contentBase64, "base64").toString("utf8");
  const result = spawnSync("/bin/bash", [], {
    input: script,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${dirname(node)}:${process.env.PATH}`,
      XDG_DATA_HOME: join(home, ".local/share"),
      DISPLAY: ":fixture",
      WSL_DISTRO_NAME: "",
    },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(await readFile(connection, "utf8")).toBe(JSON.stringify(saved));
  expect(await readFile(join(home, "setup-arguments"), "utf8")).toBe(
    `${bundle}\nsetup\n`,
  );
  return {
    bundle,
    payload: await readFile(join(home, "setup-payload.json"), "utf8"),
  };
}

test.each(["macos", "linux"] as const)(
  "%s installer → entry → existing startup keeps the originally paired Runtime URL when downloaded from a different local alias",
  async (platform) => {
    const { bundle, payload } = await runCachedInstaller(platform);
    expect(JSON.parse(payload)).toEqual({
      url: installerInput.url,
      code: installerInput.code,
      upgradeHostId: saved.hostId,
    });
    await runHostCompanionEntry(["setup"], {
      cliPath: bundle,
      input: Readable.from([payload]),
    });
    expect(resolveNativeRuntimeAddress).toHaveBeenCalledExactlyOnceWith(
      saved.url,
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ cliPath: bundle }),
    );
    expect(mocks.stopOwned).toHaveBeenCalledOnce();
    expect(mocks.state.isConnected).toHaveBeenCalledWith(
      saved.hostId,
      "upgraded-build",
      expect.any(Number),
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.state.write).not.toHaveBeenCalled();
    expect(await mocks.state.read()).toBe(saved);
  },
);

test("Windows installer carries the bounded pairing identity in setup metadata and stdin", async () => {
  const result = await renderCompanionInstaller({
    ...installerInput,
    platform: "windows",
  });
  const script = Buffer.from(result.contentBase64, "base64").toString("utf8");
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(script)![1]!;
  expect(
    JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
  ).toMatchObject(installerInput);
  expect(script).toContain("$Setup.upgradeHostId = $Metadata.upgradeHostId");
  expect(script).toContain("$Payload | & $Node $Bundle setup");
});

test.each(["different-host", "missing-state"])(
  "an upgrade with %s cannot replace registration, send credentials or begin pairing",
  async (condition) => {
    if (condition === "missing-state")
      mocks.state.read.mockResolvedValue(undefined);
    const upgradeHostId =
      condition === "different-host" ? randomUUID() : saved.hostId;
    await expect(
      runHostCompanionEntry(["setup"], {
        input: Readable.from([
          JSON.stringify({
            url: installerInput.url,
            code: installerInput.code,
            upgradeHostId,
          }),
        ]),
      }),
    ).rejects.toThrow(/different paired computer|connection is missing/u);
    expect(resolveNativeRuntimeAddress).not.toHaveBeenCalled();
    expect(mocks.stopOwned).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.state.write).not.toHaveBeenCalled();
  },
);

test("ordinary connect still rejects a changed origin even if it is another local alias", async () => {
  await expect(
    runHostCompanionCli(["connect", "--url", installerInput.url]),
  ).rejects.toThrow("already paired");
  expect(mocks.stopOwned).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.state.write).not.toHaveBeenCalled();
});

test.each(["", "x".repeat(129), "not-a-host-identifier"])(
  "installer metadata rejects malformed upgrade identity before rendering",
  async (upgradeHostId) => {
    await expect(
      renderCompanionInstaller({
        ...installerInput,
        platform: "linux",
        upgradeHostId,
      }),
    ).rejects.toThrow("paired computer identity is invalid");
  },
);
