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
} from "../../../plugins/system/source/companion/autostart.js";
import {
  createNativeHostState,
  type NativeHostConnection,
} from "../../../plugins/system/source/companion/native-state.js";
import { runNativeHostSupervisor } from "../../../plugins/system/source/companion/native-supervisor.js";
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
    expect(renderNativeAutostart(options)).toContain(
      "/fixture/a&amp;b/node",
    );
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
