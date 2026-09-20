import { readFile } from "node:fs/promises";

/** Packaged entries use their sibling CLI; source mode serves the built artifact. */
export async function readInstallerCompanionBundle(
  moduleUrl = import.meta.url,
  read: (url: URL) => Promise<Buffer> = readFile,
): Promise<Buffer> {
  try {
    return await read(new URL("../../cli/host-companion-bundle.mjs", moduleUrl));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return read(new URL("../../../dist/src/cli/host-companion-bundle.mjs", moduleUrl));
  }
}
