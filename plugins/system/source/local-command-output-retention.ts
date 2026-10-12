import { scheduleSystemOutputCleanup } from "../../../src/plugin-sdk/computer-access.js";
import { ensureWindowsOutputDirectory } from "./security/windows-output-directory.js";

/** Retention may traverse only a verified Windows output root, including at plugin load. */
export function scheduleLocalSystemOutputCleanup(root: string, retentionMs: number): Promise<void> {
  if (process.platform !== "win32") {
    scheduleSystemOutputCleanup(root, retentionMs);
    return Promise.resolve();
  }
  return ensureWindowsOutputDirectory(root).then(
    () => scheduleSystemOutputCleanup(root, retentionMs),
    () => process.emitWarning("SYSTEM output cleanup skipped because private storage could not be verified.", {
      code: "SYSTEM_OUTPUT_PRIVATE_STORAGE_UNAVAILABLE",
    }),
  );
}
