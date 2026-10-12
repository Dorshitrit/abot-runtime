import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalConfigFilePath } from "../../runtime/adapters/config-file-transaction.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

export type SetupEditFileSnapshot = Readonly<{
  bytes: string | null;
  mode: number;
}>;

export function setupEditRecoveryRequired(): RuntimeSetupError {
  return new RuntimeSetupError(
    "setup_edit_recovery_required",
    "An interrupted connection edit needs recovery. Restart this Runtime before applying configuration. If recovery reports a conflict, preserve the transaction and review the changed files.",
    409,
  );
}

export function isMissingSetupEditFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Snapshots preserve bytes, existence and mode; linked or special targets are not owned. */
export async function readSetupEditFile(
  path: string,
): Promise<SetupEditFileSnapshot> {
  if ((await canonicalConfigFilePath(path)) !== path)
    throw setupEditRecoveryRequired();
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw setupEditRecoveryRequired();
    return {
      bytes: (await readFile(path)).toString("base64"),
      mode: info.mode & 0o777,
    };
  } catch (error) {
    if (isMissingSetupEditFile(error)) return { bytes: null, mode: 0 };
    throw error;
  }
}

export function setupEditFileMatches(
  actual: SetupEditFileSnapshot,
  expected: SetupEditFileSnapshot,
): boolean {
  if (actual.bytes !== expected.bytes) return false;
  // Node's Windows chmod only implements the writable bit, unlike POSIX modes.
  const mask = process.platform === "win32" ? 0o200 : 0o777;
  return (actual.mode & mask) === (expected.mode & mask);
}

export function setupEditTextSnapshot(
  text: string,
  mode: number,
): SetupEditFileSnapshot {
  return { bytes: Buffer.from(text, "utf8").toString("base64"), mode };
}

export function setupEditSnapshotText(snapshot: SetupEditFileSnapshot): string {
  if (snapshot.bytes === null) throw setupEditRecoveryRequired();
  return Buffer.from(snapshot.bytes, "base64").toString("utf8");
}

/** Directory sync is available on Unix; Windows does not expose it through Node. */
export async function syncSetupEditDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncSetupEditFile(path: string): Promise<void> {
  // Windows FlushFileBuffers requires a handle opened for writing.
  const handle = await open(path, process.platform === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncSetupEditDirectory(dirname(path));
}

export async function requireSetupEditFileSnapshot(
  path: string,
  expected: SetupEditFileSnapshot,
): Promise<void> {
  if (!setupEditFileMatches(await readSetupEditFile(path), expected))
    throw setupEditRecoveryRequired();
}

/** Cooperative locks are held by the caller; recheck immediately before replacement. */
export async function restoreSetupEditFile(
  path: string,
  expected: SetupEditFileSnapshot,
  replacement: SetupEditFileSnapshot,
): Promise<void> {
  await requireSetupEditFileSnapshot(path, expected);
  if (replacement.bytes === null) {
    await rm(path);
    await syncSetupEditDirectory(dirname(path));
    return;
  }
  const temporary = `${path}.${randomUUID()}.setup-edit.tmp`;
  try {
    const handle = await open(temporary, "wx", replacement.mode);
    try {
      await handle.writeFile(Buffer.from(replacement.bytes, "base64"));
      await handle.chmod(replacement.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await requireSetupEditFileSnapshot(path, expected);
    await rename(temporary, path);
    await syncSetupEditDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Publish the marker itself atomically; private mode also protects credential snapshots. */
export async function publishSetupEditJournal(
  path: string,
  text: string,
  expected: SetupEditFileSnapshot,
): Promise<void> {
  await restoreSetupEditFile(
    path,
    expected,
    setupEditTextSnapshot(text, 0o600),
  );
  await chmod(path, 0o600);
}
