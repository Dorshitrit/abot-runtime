import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { withFileLock } from "../adapters/long-term-memory/file-lock.js";

const LIVE_TOKEN = "00000000-0000-4000-8000-000000000001";
const DEAD_TOKEN = "00000000-0000-4000-8000-000000000002";
const REPLACEMENT_TOKEN = "00000000-0000-4000-8000-000000000003";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("long-term memory file lock", () => {
  test("never age-reaps a lock whose owner process is alive", async () => {
    const lockPath = await createLockPath();
    const ownerPath = await installLock(
      lockPath,
      LIVE_TOKEN,
      lockRecord(process.pid, LIVE_TOKEN),
    );
    const old = new Date(0);
    await utimes(ownerPath, old, old);
    await utimes(join(lockPath, "lease"), old, old);
    await utimes(lockPath, old, old);

    await expect(
      withFileLock(lockPath, async () => undefined, {
        waitMs: 5,
        retryDelayMs: 1,
        processIsAlive: () => true,
      }),
    ).rejects.toThrow("long_term_memory_store_lock_timeout");
    await expect(readFile(ownerPath, "utf8")).resolves.toBe(
      lockRecord(process.pid, LIVE_TOKEN),
    );
  });

  test("reclaims a lock only after its recorded owner is dead", async () => {
    const lockPath = await createLockPath();
    await installLock(lockPath, DEAD_TOKEN, lockRecord(123, DEAD_TOKEN));

    await expect(
      withFileLock(lockPath, async () => "updated", {
        waitMs: 20,
        retryDelayMs: 1,
        processIsAlive: () => false,
      }),
    ).resolves.toBe("updated");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not let an old owner remove a replacement lock", async () => {
    const lockPath = await createLockPath();
    const replacementRecord = lockRecord(process.pid, REPLACEMENT_TOKEN);
    const replacementOwnerPath = join(
      lockPath,
      "lease",
      ownerFileName(REPLACEMENT_TOKEN),
    );

    await withFileLock(lockPath, async () => {
      await rm(lockPath, { force: true, recursive: true });
      await installLock(lockPath, REPLACEMENT_TOKEN, replacementRecord);
    });

    await expect(readFile(replacementOwnerPath, "utf8")).resolves.toBe(
      replacementRecord,
    );
  });

  test("does not let a stale reaper remove a replacement lock", async () => {
    const lockPath = await createLockPath();
    const staleOwnerPath = await installLock(
      lockPath,
      DEAD_TOKEN,
      lockRecord(123, DEAD_TOKEN),
    );
    const replacementOwnerPath = join(
      lockPath,
      "lease",
      ownerFileName(REPLACEMENT_TOKEN),
    );
    const replacementRecord = lockRecord(process.pid, REPLACEMENT_TOKEN);
    let replaced = false;

    await expect(
      withFileLock(lockPath, async () => undefined, {
        waitMs: 5,
        retryDelayMs: 1,
        processIsAlive: (pid) => {
          if (pid === 123 && !replaced) {
            unlinkSync(staleOwnerPath);
            rmdirSync(join(lockPath, "lease"));
            rmdirSync(lockPath);
            mkdirSync(join(lockPath, "lease"), {
              mode: 0o700,
              recursive: true,
            });
            writeFileSync(replacementOwnerPath, replacementRecord, {
              encoding: "utf8",
              mode: 0o600,
            });
            replaced = true;
            return false;
          }
          return pid === process.pid;
        },
      }),
    ).rejects.toThrow("long_term_memory_store_lock_timeout");

    expect(replaced).toBe(true);
    await expect(readFile(replacementOwnerPath, "utf8")).resolves.toBe(
      replacementRecord,
    );
  });
});

async function createLockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "long-term-memory-file-lock-"));
  temporaryRoots.push(root);
  return join(root, "memory.lock");
}

async function installLock(
  lockPath: string,
  token: string,
  contents: string,
): Promise<string> {
  const leasePath = join(lockPath, "lease");
  await mkdir(leasePath, { mode: 0o700, recursive: true });
  const ownerPath = join(leasePath, ownerFileName(token));
  await writeFile(ownerPath, contents, { encoding: "utf8", mode: 0o600 });
  return ownerPath;
}

function lockRecord(pid: number, token: string): string {
  return JSON.stringify({
    pid,
    token,
    createdAt: "2026-08-27T00:00:00.000Z",
  });
}

function ownerFileName(token: string): string {
  return `owner-${token}.json`;
}
