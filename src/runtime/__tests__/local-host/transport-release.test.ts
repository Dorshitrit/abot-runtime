import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("graceful process exit cannot interrupt local-owner release between removing its marker and directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-owner-release-"));
  directories.push(directory);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./release-on-exit-worker.ts", import.meta.url)),
      directory,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  const ownerPath = join(directory, "owner");
  const leasePath = join(ownerPath, "lease");
  const diagnostic = JSON.stringify({
    leaseEntries: existsSync(leasePath) ? readdirSync(leasePath) : null,
    enteredAsyncCleanup: existsSync(join(directory, "interrupted-release")),
  });
  expect(existsSync(ownerPath), diagnostic).toBe(false);
  expect(existsSync(join(directory, "endpoint.json"))).toBe(false);
  expect(existsSync(join(directory, "interrupted-release"))).toBe(false);
});
