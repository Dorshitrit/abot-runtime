import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NativeAutostartOptions } from "../../computer-access/companion/autostart.js";
import {
  NATIVE_RUNTIME_INSTALLATION_FAILURE,
  prepareNativeCompanionRuntime,
} from "../../computer-access/companion/native-runtime-installation.js";

let root: string;
let startup: NativeAutostartOptions;
let managed: string;
const sourceBytes = Buffer.alloc(196_613, 65);

beforeEach(async () => {
  const scratch = resolve(".codex/artifacts/macos-managed-node-20260928");
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "native-runtime-"));
  const source = join(root, "source-node");
  await writeFile(source, sourceBytes, { mode: 0o755 });
  startup = {
    platform: "darwin",
    homeDir: root,
    stateDir: join(root, "private-state"),
    nodePath: source,
    cliPath: join(root, "companion.mjs"),
    uid: process.getuid?.(),
  };
  managed = join(startup.stateDir, "runtime", "node");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function versionExecutor() {
  return vi.fn(async () => "v22.12.0\n");
}

async function existingRuntime(bytes = Buffer.from("previous runtime")) {
  await mkdir(join(startup.stateDir, "runtime"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(managed, bytes, { mode: 0o500 });
}

test("streams exact source bytes into one private fixed executable and bounds both preflights", async () => {
  const execute = versionExecutor();
  const result = await prepareNativeCompanionRuntime(startup, { execute });
  expect(result).toEqual({ ...startup, nodePath: managed });
  expect(await readFile(managed)).toEqual(sourceBytes);
  expect((await lstat(managed)).mode & 0o777).toBe(0o500);
  expect((await lstat(join(startup.stateDir, "runtime"))).mode & 0o777).toBe(
    0o700,
  );
  expect(await readdir(join(startup.stateDir, "runtime"))).toEqual(["node"]);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[0]).toEqual([
    startup.nodePath,
    ["--version"],
    {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1_024,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  ]);
});

test("same-byte reuse preserves the managed inode across different source installations", async () => {
  const execute = versionExecutor();
  await prepareNativeCompanionRuntime(startup, { execute });
  const original = await lstat(managed);
  const nextSource = join(root, "another-version-manager-node");
  await writeFile(nextSource, sourceBytes, { mode: 0o755 });
  await prepareNativeCompanionRuntime(
    { ...startup, nodePath: nextSource },
    { execute },
  );
  const reused = await lstat(managed);
  expect(reused.ino).toBe(original.ino);
  expect(reused.mtimeMs).toBe(original.mtimeMs);
});

test("different source versions atomically replace bytes at the same path without version caches", async () => {
  const execute = versionExecutor();
  await prepareNativeCompanionRuntime(startup, { execute });
  const previous = await lstat(managed);
  const nextSource = join(root, "new-node");
  const nextBytes = Buffer.alloc(131_097, 66);
  await writeFile(nextSource, nextBytes, { mode: 0o755 });
  execute.mockResolvedValue("v24.0.0\n");
  const result = await prepareNativeCompanionRuntime(
    { ...startup, nodePath: nextSource },
    { execute },
  );
  expect(result.nodePath).toBe(managed);
  expect(await readFile(managed)).toEqual(nextBytes);
  expect((await lstat(managed)).ino).not.toBe(previous.ino);
  expect(await readdir(join(startup.stateDir, "runtime"))).toEqual(["node"]);
});

test("setup started by the managed executable reuses that executable", async () => {
  await existingRuntime(sourceBytes);
  const before = await lstat(managed);
  await prepareNativeCompanionRuntime(
    { ...startup, nodePath: managed },
    { execute: versionExecutor() },
  );
  expect((await lstat(managed)).ino).toBe(before.ino);
});

test.each(["win32", "linux"] as const)(
  "leaves %s options and filesystem untouched",
  async (platform) => {
    const input = { ...startup, platform };
    const execute = versionExecutor();
    expect(await prepareNativeCompanionRuntime(input, { execute })).toBe(input);
    expect(execute).not.toHaveBeenCalled();
    await expect(lstat(startup.stateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

test.each(["symlink", "hardlink", "writable", "public", "directory"] as const)(
  "rejects an unexpected managed target: %s",
  async (kind) => {
    await existingRuntime();
    await rm(managed);
    const outside = join(root, "outside");
    await writeFile(outside, "preserve outside", { mode: 0o500 });
    if (kind === "symlink") await symlink(outside, managed);
    if (kind === "hardlink") await link(outside, managed);
    if (kind === "writable") await writeFile(managed, "bad", { mode: 0o700 });
    if (kind === "public") await writeFile(managed, "bad", { mode: 0o555 });
    if (kind === "directory") await mkdir(managed);
    const execute = versionExecutor();
    await expect(
      prepareNativeCompanionRuntime(startup, { execute }),
    ).rejects.toThrow(NATIVE_RUNTIME_INSTALLATION_FAILURE);
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(outside, "utf8")).toBe("preserve outside");
  },
);

test.each(["symlink", "public", "wrong-owner"] as const)(
  "rejects an unsafe runtime directory: %s",
  async (kind) => {
    await existingRuntime();
    const directory = join(startup.stateDir, "runtime");
    if (kind === "symlink") {
      await rm(directory, { recursive: true });
      await symlink(root, directory);
    }
    if (kind === "public") await chmod(directory, 0o755);
    if (kind === "wrong-owner")
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    await expect(
      prepareNativeCompanionRuntime(startup, { execute: versionExecutor() }),
    ).rejects.toThrow(NATIVE_RUNTIME_INSTALLATION_FAILURE);
  },
);

test.each(["error", "mismatched-version", "malformed-version"] as const)(
  "failed staged preflight preserves the original target and removes only the temporary copy: %s",
  async (kind) => {
    await existingRuntime();
    const before = await lstat(managed);
    const execute = versionExecutor().mockImplementationOnce(
      async () => "v22.12.0\n",
    );
    if (kind === "error")
      execute.mockRejectedValueOnce(new Error("secret dynamic library path"));
    if (kind === "mismatched-version")
      execute.mockResolvedValueOnce("v24.0.0\n");
    if (kind === "malformed-version")
      execute.mockResolvedValueOnce("arbitrary output\n");
    await expect(
      prepareNativeCompanionRuntime(startup, { execute }),
    ).rejects.toThrow(NATIVE_RUNTIME_INSTALLATION_FAILURE);
    expect(await readFile(managed, "utf8")).toBe("previous runtime");
    expect((await lstat(managed)).ino).toBe(before.ino);
    expect(await readdir(join(startup.stateDir, "runtime"))).toEqual(["node"]);
  },
);

test("refuses a target replaced while staged preflight ran", async () => {
  await existingRuntime();
  let calls = 0;
  const execute = vi.fn(async () => {
    calls++;
    if (calls === 2) {
      await rm(managed);
      await writeFile(managed, "replacement owned by another attempt", {
        mode: 0o500,
      });
    }
    return "v22.12.0\n";
  });
  await expect(
    prepareNativeCompanionRuntime(startup, { execute }),
  ).rejects.toThrow(NATIVE_RUNTIME_INSTALLATION_FAILURE);
  expect(await readFile(managed, "utf8")).toBe(
    "replacement owned by another attempt",
  );
  expect(await readdir(join(startup.stateDir, "runtime"))).toEqual(["node"]);
});

test("rejects a writable source without executing or activating it", async () => {
  await chmod(startup.nodePath, 0o777);
  const execute = versionExecutor();
  await expect(
    prepareNativeCompanionRuntime(startup, { execute }),
  ).rejects.toThrow(NATIVE_RUNTIME_INSTALLATION_FAILURE);
  expect(execute).not.toHaveBeenCalled();
  await expect(lstat(managed)).rejects.toMatchObject({ code: "ENOENT" });
});

test("the real current Node from a trusted fixture passes relocation preflight without startup registration", async () => {
  // Hosted toolcache ownership and modes are not this fixture's trust contract.
  await copyFile(process.execPath, startup.nodePath);
  await chmod(startup.nodePath, 0o755);
  const result = await prepareNativeCompanionRuntime(startup);
  expect(result.nodePath).toBe(managed);
  expect((await lstat(managed)).size).toBe(
    (await lstat(process.execPath)).size,
  );
});
