import { promises as asyncFs, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [directory] = process.argv.slice(2);
const lockPath = join(directory, "owner");
const originalRmdir = asyncFs.rmdir;
// Reproduce process.exit during the real asynchronous release sequence without
// depending on disk timing. Synchronous release never enters these barriers.
asyncFs.unlink = async (path) => unlinkSync(path);
asyncFs.rmdir = async (path) => {
  if (resolve(String(path)) === join(lockPath, "lease")) {
    writeFileSync(join(directory, "interrupted-release"), "async release");
    return new Promise<void>(() => {});
  }
  return originalRmdir(path);
};

const { createLocalRuntimeConnection } =
  await import("../../local-host/transport.js");
const connection = await createLocalRuntimeConnection({
  directory,
  identity: "graceful-exit-fixture",
  createOwner: async () => ({
    call: async () => undefined,
    subscribe: () => () => {},
    stop: async () => {},
    whenIdle: async () => {},
  }),
});
await connection.close();
process.exit(0);
