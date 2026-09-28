vi.mock("../../computer-access/companion/native-notifications.js", () => ({
  createNativeNotificationSession: vi.fn(async () => ({ ready: false, handlers: () => ({}), close: () => {} })),
}));
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  installNativeAutostart,
  nativeAutostartFile,
  renderNativeAutostart,
  uninstallNativeAutostart,
  type NativeAutostartOptions,
} from "../../computer-access/companion/autostart.js";
import {
  createNativeHostState,
  type NativeHostConnection,
} from "../../computer-access/companion/native-state.js";
import { runNativeHostSupervisor } from "../../computer-access/companion/native-supervisor.js";
import { readNativeCompanionBuildId } from "../../computer-access/companion/native-build-identity.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";
import { assertPrivateRuntimeAccess } from "../local-host/private-access.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-native-test-"));
  temporary.push(directory);
  const state = createNativeHostState(join(directory, "private"), {
    ensureDirectory: ensurePrivateRuntimeDirectory,
    assertFile: (path, information) =>
      assertPrivateRuntimeAccess(path, information, "not_private"),
  });
  const connection: NativeHostConnection = {
    version: 1,
    url: "ws://abot.localhost:5184",
    hostId: randomUUID(),
    credential: "a".repeat(43),
  };
  return { directory, state, connection };
}

describe("native credential lifetime", () => {
  test("readiness requires the exact entry bundle and rejects legacy or stale build status", async () => {
    const { directory, state, connection } = await fixture();
    const bundle = join(directory, "companion.mjs");
    await writeFile(bundle, "old bundle");
    const oldBuild = await readNativeCompanionBuildId(bundle);
    await writeFile(bundle, "new bundle");
    const newBuild = await readNativeCompanionBuildId(bundle);
    expect(newBuild).not.toBe(oldBuild);
    await state.setStatus(connection.hostId, true);
    expect(await state.isConnected(connection.hostId)).toBe(true);
    expect(await state.isConnected(connection.hostId, newBuild)).toBe(false);
    await state.setStatus(connection.hostId, true, oldBuild);
    expect(await state.isConnected(connection.hostId, newBuild)).toBe(false);
    await state.setStatus(connection.hostId, true, newBuild);
    expect(await state.isConnected(connection.hostId, newBuild)).toBe(true);
    expect(
      await state.isConnected(connection.hostId, newBuild, Date.now()),
    ).toBe(false);
    expect(await state.isConnected(randomUUID(), newBuild)).toBe(false);
    await state.setStatus(connection.hostId, false, newBuild);
    expect(await state.isConnected(connection.hostId, newBuild)).toBe(false);
  });
  test("stores a private credential and compare-removes only the intended pairing", async () => {
    const { state, connection } = await fixture();
    await state.write(connection);
    expect(await state.read()).toEqual(connection);
    if (process.platform !== "win32")
      expect(
        (await stat(join(state.directory, "connection.json"))).mode & 0o777,
      ).toBe(0o600);
    await state.remove({ ...connection, credential: "b".repeat(43) });
    expect(await state.read()).toEqual(connection);
    await state.remove(connection);
    expect(await state.read()).toBeUndefined();
  });
  test("explicit disconnect removes private malformed state while revocation remains identity-bound", async () => {
    const { state, connection } = await fixture();
    await state.write(connection);
    const path = join(state.directory, "connection.json");
    await writeFile(path, "malformed credential JSON", { mode: 0o600 });
    await expect(state.remove(connection)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("malformed credential JSON");
    await state.remove();
    expect(await state.read()).toBeUndefined();
  });
  test.skipIf(process.platform === "win32")(
    "rejects symlink credentials without changing their target",
    async () => {
      const { directory, state, connection } = await fixture();
      await state.read();
      const target = join(directory, "unrelated.json");
      await writeFile(target, "unchanged");
      await symlink(target, join(state.directory, "connection.json"));
      await expect(state.read()).rejects.toThrow("private regular file");
      await expect(state.write(connection)).rejects.toThrow(
        "private regular file",
      );
      expect(await readFile(target, "utf8")).toBe("unchanged");
    },
  );
  test("connection restart admits a new session but retains the same private pairing", async () => {
    const { state, connection } = await fixture();
    await state.write(connection);
    const stop = new AbortController();
    let attempts = 0;
    const connect = vi.fn(async (options) => {
      attempts += 1;
      expect(options.authorization).toBe(connection.credential);
      expect(options.hostId).toBe(connection.hostId);
      await options.onReady(connection.hostId);
      expect(await state.isConnected(connection.hostId, "current-build")).toBe(
        true,
      );
      if (attempts === 1) return "disconnected" as const;
      stop.abort();
      return "stopped" as const;
    });
    await runNativeHostSupervisor({
      state,
      identity: {
        name: "test",
        os: "windows",
        user: "test",
        homeDir: "C:\\Users\\test",
      },
      signal: stop.signal,
      reconnectDelayMs: 1,
      buildId: "current-build",
      connect,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(await state.read()).toEqual(connection);
  });
  test("revocation removes the saved credential and makes no reconnect attempt", async () => {
    const { state, connection } = await fixture();
    await state.write(connection);
    const connect = vi.fn(async () => "authorization_rejected" as const);
    await runNativeHostSupervisor({
      state,
      identity: {
        name: "test",
        os: "windows",
        user: "test",
        homeDir: "C:\\Users\\test",
      },
      signal: new AbortController().signal,
      connect,
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(await state.read()).toBeUndefined();
  });
  test("deleting the local pairing aborts the active connection", async () => {
    const { state, connection } = await fixture();
    await state.write(connection);
    let signal: AbortSignal | undefined;
    const connect = vi.fn(async (options) => {
      signal = options.signal;
      return new Promise<"stopped">((resolve) =>
        options.signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        }),
      );
    });
    const running = runNativeHostSupervisor({
      state,
      identity: {
        name: "test",
        os: "windows",
        user: "test",
        homeDir: "C:\\Users\\test",
      },
      signal: new AbortController().signal,
      connect,
    });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    await state.remove();
    await running;
    expect(signal?.aborted).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
  });
});

describe("current-user login registration", () => {
  function settings(
    directory: string,
    platform: NodeJS.Platform,
  ): NativeAutostartOptions {
    return {
      platform,
      homeDir: directory,
      appData: join(directory, "AppData"),
      uid: 501,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath: "C:\\A Bot\\bin.js",
      stateDir: join(directory, "private"),
      execute: vi.fn(async () => {}),
    };
  }
  test("Windows registration runs the exact executable hidden without storing credentials", async () => {
    const { directory } = await fixture();
    const options = settings(directory, "win32");
    const source = renderNativeAutostart(options);
    expect(source).toContain(
      'shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\A Bot\\bin.js"" host run", 0, False',
    );
    expect(source).not.toContain("credential");
    expect(await installNativeAutostart(options)).toEqual({ started: false });
    expect(await readFile(nativeAutostartFile(options), "utf8")).toBe(source);
    expect(options.execute).not.toHaveBeenCalled();
    await uninstallNativeAutostart(options);
    await expect(stat(nativeAutostartFile(options))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  test("macOS registers an Aqua user agent and escapes paths as XML data", async () => {
    const { directory } = await fixture();
    const options = {
      ...settings(directory, "darwin"),
      nodePath: "/fixture/a&b/node",
      cliPath: "/fixture/A Bot/bin.js",
    };
    expect(renderNativeAutostart(options)).toContain("/fixture/a&amp;b/node");
    expect(renderNativeAutostart(options)).toContain("<string>Aqua</string>");
    expect(await installNativeAutostart(options)).toEqual({ started: true });
    expect(options.execute).toHaveBeenCalledWith("/bin/launchctl", [
      "bootstrap",
      "gui/501",
      nativeAutostartFile(options),
    ]);
    await uninstallNativeAutostart(options);
    expect(options.execute).toHaveBeenCalledWith("/bin/launchctl", [
      "bootout",
      "gui/501/com.abot.host-companion",
    ]);
  });
  test.skipIf(process.platform === "win32")(
    "Linux installs and removes its registration under the absolute XDG config home",
    async () => {
      const { directory } = await fixture();
      const options = {
        ...settings(directory, "linux"),
        xdgConfigHome: join(directory, "custom-config"),
        nodePath: "/fixture/node",
        cliPath: "/fixture/companion.mjs",
      };
      const path = join(
        options.xdgConfigHome,
        "autostart",
        "com.abot.host-companion.desktop",
      );
      expect(nativeAutostartFile(options)).toBe(path);
      expect(await installNativeAutostart(options)).toEqual({ started: false });
      expect(await readFile(path, "utf8")).toBe(renderNativeAutostart(options));
      expect(options.execute).not.toHaveBeenCalled();
      await uninstallNativeAutostart(options);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  test.each([undefined, "", "relative/config"])(
    "Linux falls back to the home config directory for XDG_CONFIG_HOME=%s",
    async (xdgConfigHome) => {
      const { directory } = await fixture();
      const options = { ...settings(directory, "linux"), xdgConfigHome };
      expect(nativeAutostartFile(options)).toBe(
        join(
          directory,
          ".config",
          "autostart",
          "com.abot.host-companion.desktop",
        ),
      );
    },
  );
  test("preserves an unmanaged startup file", async () => {
    const { directory } = await fixture();
    const options = settings(directory, "win32");
    await installNativeAutostart(options);
    await writeFile(nativeAutostartFile(options), "user-owned content");
    await expect(installNativeAutostart(options)).rejects.toThrow("unmanaged");
    await expect(uninstallNativeAutostart(options)).rejects.toThrow(
      "unmanaged",
    );
    expect(await readFile(nativeAutostartFile(options), "utf8")).toBe(
      "user-owned content",
    );
  });
});
