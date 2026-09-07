import type { Stats } from "node:fs";
import { verifyWindowsPrivateAccess } from "./windows-private-access.js";

export async function assertPrivateRuntimeAccess(
  path: string,
  stat: Stats,
  errorCode: string,
  newlyCreatedDirectory = false,
): Promise<void> {
  if (process.platform === "win32") {
    try {
      await verifyWindowsPrivateAccess(path, newlyCreatedDirectory);
      return;
    } catch {
      throw new Error(errorCode);
    }
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(errorCode);
  if (process.getuid?.() !== stat.uid) throw new Error(errorCode);
}
