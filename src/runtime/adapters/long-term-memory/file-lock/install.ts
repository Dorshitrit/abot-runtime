import { mkdir, open, rename, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { removeDirectoryIfEmpty, removeStagingLock } from "./cleanup.js";
import { LEASE_DIRECTORY_NAME, ownerFileName } from "./contracts.js";
import { hasValidOptionalLockOwnerIdentity } from "./owner-identity.js";

export async function installLockDirectory(
  lockPath: string,
  token: string,
  ownerIdentity?: string,
): Promise<void> {
  if (!hasValidOptionalLockOwnerIdentity(ownerIdentity))
    throw new Error("file_lock_owner_identity_invalid");
  const stagingPath = `${lockPath}.${process.pid}.${token}.pending`;
  const stagingOwnerPath = join(stagingPath, ownerFileName(token));
  let handle: FileHandle | undefined;
  let claimedLockPath = false;
  let installed = false;
  try {
    await mkdir(stagingPath, { mode: 0o700 });
    handle = await open(stagingOwnerPath, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
        ...(ownerIdentity === undefined ? {} : { ownerIdentity }),
      }),
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;

    await mkdir(lockPath, { mode: 0o700 });
    claimedLockPath = true;
    await rename(stagingPath, join(lockPath, LEASE_DIRECTORY_NAME));
    installed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!installed) {
      await removeStagingLock(stagingPath, stagingOwnerPath);
      if (claimedLockPath) {
        await removeDirectoryIfEmpty(lockPath);
      }
    }
  }
}
