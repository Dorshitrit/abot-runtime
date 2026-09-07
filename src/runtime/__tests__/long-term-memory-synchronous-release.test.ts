import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createLock() {
  const root = await mkdtemp(join(tmpdir(), "synchronous-owner-release-"));
  roots.push(root);
  const lockPath = join(root, "owner");
  const release = await acquireFileLock(lockPath, {
    releaseMode: "synchronous",
  });
  return { lockPath, release };
}

test("synchronous release removes the complete lease before yielding its promise and is idempotent", async () => {
  const { lockPath, release } = await createLock();
  const completion = release();
  expect(existsSync(lockPath)).toBe(false);
  await completion;
  await release();
});

test("synchronous release never removes a replacement owner's token or directory", async () => {
  const { lockPath, release } = await createLock();
  await rm(lockPath, { recursive: true });
  const leasePath = join(lockPath, "lease");
  await mkdir(leasePath, { recursive: true });
  const token = "00000000-0000-4000-8000-000000000003";
  const recordPath = join(leasePath, `owner-${token}.json`);
  const record = JSON.stringify({
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  });
  await writeFile(recordPath, record);
  await release();
  expect(await readFile(recordPath, "utf8")).toBe(record);
});
