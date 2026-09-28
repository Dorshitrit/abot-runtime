import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Identifies the exact entry bundle used by setup and the running companion. */
export async function readNativeCompanionBuildId(
  cliPath: string,
): Promise<string> {
  return createHash("sha256")
    .update(await readFile(cliPath))
    .digest("hex");
}
