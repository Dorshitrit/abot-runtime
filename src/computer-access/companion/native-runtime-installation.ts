import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertPrivateRuntimeAccess } from "../../runtime/local-host/private-access.js";
import { ensurePrivateRuntimeDirectory } from "../../runtime/local-host/private-directory.js";
import type { NativeAutostartOptions } from "./autostart.js";

const executeFile = promisify(execFile);
export const NATIVE_RUNTIME_INSTALLATION_FAILURE =
  "The Mac companion runtime could not be prepared safely. The saved pairing was not changed. Check the local Node.js installation and run setup again.";

type RuntimeVersionOptions = Readonly<{
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  killSignal: "SIGKILL";
  windowsHide: true;
}>;

export type NativeRuntimeInstallationDependencies = Readonly<{
  execute(
    file: string,
    args: readonly string[],
    options: RuntimeVersionOptions,
  ): Promise<string>;
}>;

type RuntimeFile = Readonly<{ stat: Stats; digest: string }>;

function runtimeInstallationFailure(): Error {
  return new Error(NATIVE_RUNTIME_INSTALLATION_FAILURE);
}

function isAbsentRuntimePath(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function hasSameRuntimeIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== right.ino) return false;
  if (left.size !== right.size) return false;
  if (left.mtimeMs !== right.mtimeMs) return false;
  return left.ctimeMs === right.ctimeMs;
}

function hasTrustedRuntimeSource(stat: Stats): boolean {
  if (!stat.isFile()) return false;
  if (stat.isSymbolicLink()) return false;
  if ((stat.mode & 0o111) === 0) return false;
  if ((stat.mode & 0o022) !== 0) return false;
  if (stat.uid === 0) return true;
  return stat.uid === process.getuid?.();
}

async function requireManagedRuntimeFile(
  path: string,
  stat: Stats,
): Promise<void> {
  if (!stat.isFile()) throw runtimeInstallationFailure();
  if (stat.isSymbolicLink()) throw runtimeInstallationFailure();
  if (stat.nlink !== 1) throw runtimeInstallationFailure();
  if ((stat.mode & 0o777) !== 0o500) throw runtimeInstallationFailure();
  await assertPrivateRuntimeAccess(
    path,
    stat,
    NATIVE_RUNTIME_INSTALLATION_FAILURE,
  );
}

async function streamRuntimeDigest(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({
    start: 0,
    autoClose: false,
  }))
    hash.update(chunk);
  return hash.digest("hex");
}

async function readRuntimeFile(
  path: string,
  managed: boolean,
): Promise<RuntimeFile | undefined> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (isAbsentRuntimePath(error)) return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (managed) await requireManagedRuntimeFile(path, stat);
  if (!managed && !hasTrustedRuntimeSource(stat))
    throw runtimeInstallationFailure();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!hasSameRuntimeIdentity(stat, await handle.stat()))
      throw runtimeInstallationFailure();
    const digest = await streamRuntimeDigest(handle);
    if (!hasSameRuntimeIdentity(stat, await handle.stat()))
      throw runtimeInstallationFailure();
    if (!hasSameRuntimeIdentity(stat, await lstat(path)))
      throw runtimeInstallationFailure();
    return { stat, digest };
  } finally {
    await handle.close();
  }
}

async function runtimeVersion(
  path: string,
  dependencies: NativeRuntimeInstallationDependencies,
): Promise<string> {
  const version = (
    await dependencies.execute(path, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1_024,
      killSignal: "SIGKILL",
      windowsHide: true,
    })
  ).trim();
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version))
    throw runtimeInstallationFailure();
  return version;
}

async function requireRuntimeVersion(
  path: string,
  expected: string,
  dependencies: NativeRuntimeInstallationDependencies,
): Promise<void> {
  if ((await runtimeVersion(path, dependencies)) !== expected)
    throw runtimeInstallationFailure();
}

async function copyRuntimeSource(
  source: string,
  staged: string,
  expected: RuntimeFile,
): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!hasSameRuntimeIdentity(expected.stat, await input.stat()))
      throw runtimeInstallationFailure();
    const output = await open(
      staged,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const hash = createHash("sha256");
      for await (const chunk of input.createReadStream({
        start: 0,
        autoClose: false,
      })) {
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      if (hash.digest("hex") !== expected.digest)
        throw runtimeInstallationFailure();
      if (!hasSameRuntimeIdentity(expected.stat, await input.stat()))
        throw runtimeInstallationFailure();
      await output.chmod(0o500);
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function requireUnchangedRuntimeTarget(
  path: string,
  expected?: RuntimeFile,
): Promise<void> {
  const current = await readRuntimeFile(path, true);
  if (!expected) {
    if (current) throw runtimeInstallationFailure();
    return;
  }
  if (!current) throw runtimeInstallationFailure();
  if (!hasSameRuntimeIdentity(expected.stat, current.stat))
    throw runtimeInstallationFailure();
  if (current.digest !== expected.digest) throw runtimeInstallationFailure();
}

async function requireUnchangedRuntimeDirectory(
  path: string,
  expected: Stats,
): Promise<void> {
  await ensurePrivateRuntimeDirectory(path);
  const current = await lstat(path);
  if (expected.dev !== current.dev) throw runtimeInstallationFailure();
  if (expected.ino !== current.ino) throw runtimeInstallationFailure();
}

async function installManagedRuntime(
  startup: NativeAutostartOptions,
  dependencies: NativeRuntimeInstallationDependencies,
): Promise<string> {
  await ensurePrivateRuntimeDirectory(startup.stateDir);
  const stateIdentity = await lstat(startup.stateDir);
  const directory = join(startup.stateDir, "runtime");
  await ensurePrivateRuntimeDirectory(directory);
  const directoryIdentity = await lstat(directory);
  const target = join(directory, "node");
  const source = await readRuntimeFile(startup.nodePath, false);
  if (!source) throw runtimeInstallationFailure();
  const existing = await readRuntimeFile(target, true);
  const expectedVersion = await runtimeVersion(startup.nodePath, dependencies);
  if (existing?.digest === source.digest) {
    await requireRuntimeVersion(target, expectedVersion, dependencies);
    await requireUnchangedRuntimeDirectory(startup.stateDir, stateIdentity);
    await requireUnchangedRuntimeDirectory(directory, directoryIdentity);
    await requireUnchangedRuntimeTarget(target, existing);
    return target;
  }
  const staged = join(directory, ".node-" + randomUUID() + ".tmp");
  try {
    await copyRuntimeSource(startup.nodePath, staged, source);
    const stagedFile = await readRuntimeFile(staged, true);
    if (stagedFile?.digest !== source.digest)
      throw runtimeInstallationFailure();
    await requireRuntimeVersion(staged, expectedVersion, dependencies);
    await requireUnchangedRuntimeTarget(staged, stagedFile);
    await requireUnchangedRuntimeDirectory(startup.stateDir, stateIdentity);
    await requireUnchangedRuntimeDirectory(directory, directoryIdentity);
    await requireUnchangedRuntimeTarget(target, existing);
    await rename(staged, target);
    return target;
  } finally {
    await unlink(staged).catch((error: unknown) => {
      if (!isAbsentRuntimePath(error)) throw error;
    });
  }
}

/** The stopped Mac companion uses one private executable path across Node upgrades. */
export async function prepareNativeCompanionRuntime(
  startup: NativeAutostartOptions,
  overrides: Partial<NativeRuntimeInstallationDependencies> = {},
): Promise<NativeAutostartOptions> {
  if (startup.platform !== "darwin") return startup;
  const dependencies: NativeRuntimeInstallationDependencies = {
    execute: async (file, args, options) =>
      (await executeFile(file, [...args], options)).stdout,
    ...overrides,
  };
  try {
    return {
      ...startup,
      nodePath: await installManagedRuntime(startup, dependencies),
    };
  } catch {
    throw runtimeInstallationFailure();
  }
}
