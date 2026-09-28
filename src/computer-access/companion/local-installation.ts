import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertPrivateRuntimeAccess } from "../../runtime/local-host/private-access.js";
import { ensurePrivateRuntimeDirectory } from "../../runtime/local-host/private-directory.js";
import {
  LocalCompanionSetupError,
  runLocalCompanionSetup,
  type LocalSetupProcessDependencies,
} from "./local-setup-process.js";

export { LocalCompanionSetupError } from "./local-setup-process.js";

export type LocalCompanionInstallationDependencies =
  LocalSetupProcessDependencies &
    Readonly<{
      platform?: NodeJS.Platform;
      homeDir?: string;
    }>;

function isMissingCachePath(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function isExistingCachePath(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "EEXIST";
}

function hasOwnedInstallationAncestor(stat: Stats): boolean {
  if (!stat.isDirectory()) return false;
  if (stat.isSymbolicLink()) return false;
  if (stat.uid !== process.getuid?.()) return false;
  return (stat.mode & 0o022) === 0;
}

async function requireOwnedInstallationAncestor(path: string): Promise<void> {
  if (!hasOwnedInstallationAncestor(await lstat(path)))
    throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
}

async function prepareInstallationDirectory(homeDir: string): Promise<string> {
  await requireOwnedInstallationAncestor(homeDir);
  let directory = homeDir;
  for (const segment of ["Library", "Application Support", "ABot"]) {
    directory = join(directory, segment);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isExistingCachePath(error)) throw error;
    });
    await requireOwnedInstallationAncestor(directory);
  }
  directory = join(directory, "HostCompanion");
  await ensurePrivateRuntimeDirectory(directory);
  return directory;
}

function bundleDigest(bundle: Buffer): string {
  return createHash("sha256").update(bundle).digest("hex");
}

function hasRegularSingleLinkBundle(
  stat: Stats,
  expectedSize: number,
): boolean {
  if (!stat.isFile()) return false;
  if (stat.nlink !== 1) return false;
  return stat.size === expectedSize;
}

function hasSameBundleIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev) return false;
  return left.ino === right.ino;
}

async function verifyCachedBundle(
  path: string,
  bundle: Buffer,
  digest: string,
): Promise<boolean> {
  const identity = await lstat(path).catch((error: unknown) => {
    if (isMissingCachePath(error)) return undefined;
    throw error;
  });
  if (!identity) return false;
  if (!hasRegularSingleLinkBundle(identity, bundle.length))
    throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
  await assertPrivateRuntimeAccess(
    path,
    identity,
    "host_local_setup_unsafe_cache",
  );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!hasSameBundleIdentity(identity, opened))
      throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
    if (!hasRegularSingleLinkBundle(opened, bundle.length))
      throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
    await assertPrivateRuntimeAccess(
      path,
      opened,
      "host_local_setup_unsafe_cache",
    );
    if (bundleDigest(await handle.readFile()) !== digest)
      throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
    if (!hasSameBundleIdentity(opened, await lstat(path)))
      throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
    return true;
  } finally {
    await handle.close();
  }
}

async function publishImmutableBundle(
  directory: string,
  path: string,
  bundle: Buffer,
): Promise<void> {
  const staged = join(directory, ".companion-" + randomUUID() + ".tmp");
  const handle = await open(
    staged,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bundle);
    await handle.sync();
    await handle.close();
    await link(staged, path).catch((error: unknown) => {
      if (!isExistingCachePath(error)) throw error;
    });
  } finally {
    await handle.close();
    await unlink(staged);
  }
}

async function installVerifiedBundle(
  homeDir: string,
  bundle: Buffer,
): Promise<string> {
  try {
    const directory = await prepareInstallationDirectory(homeDir);
    const digest = bundleDigest(bundle);
    const path = join(directory, "companion-" + digest + ".mjs");
    if (!(await verifyCachedBundle(path, bundle, digest)))
      await publishImmutableBundle(directory, path, bundle);
    await ensurePrivateRuntimeDirectory(directory);
    if (!(await verifyCachedBundle(path, bundle, digest)))
      throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
    return path;
  } catch {
    throw new LocalCompanionSetupError("host_local_setup_unsafe_cache");
  }
}

/** Install trusted server-owned bytes and reuse the existing native setup entry. */
export async function installLocalMacCompanion(
  input: Readonly<{
    bundle: Buffer;
    url: string;
    code: string;
    upgradeHostId?: string;
  }>,
  dependencies: LocalCompanionInstallationDependencies = {},
): Promise<void> {
  if ((dependencies.platform ?? process.platform) !== "darwin")
    throw new LocalCompanionSetupError("host_local_setup_unavailable");
  const homeDir = dependencies.homeDir ?? homedir();
  const bundlePath = await installVerifiedBundle(homeDir, input.bundle);
  const payload = JSON.stringify({
    url: input.url,
    code: input.code,
    ...(input.upgradeHostId === undefined
      ? {}
      : { upgradeHostId: input.upgradeHostId }),
  });
  await runLocalCompanionSetup({ bundlePath, homeDir, payload }, dependencies);
}
