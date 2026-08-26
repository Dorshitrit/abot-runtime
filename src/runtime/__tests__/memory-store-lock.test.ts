import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { acquireStoreLock } from "../../../plugins/memory/source/store-lock.js";

const temporaryRoots: string[] = [];
const LIVE_TOKEN = "00000000-0000-4000-8000-000000000001";
const DEAD_TOKEN = "00000000-0000-4000-8000-000000000002";
const PARTIAL_TOKEN = "00000000-0000-4000-8000-000000000003";
const REPLACEMENT_TOKEN = "00000000-0000-4000-8000-000000000004";

function ownerFileName(token: string): string {
  return `owner-${token}.json`;
}

async function createStorePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-store-lock-"));
  temporaryRoots.push(root);
  return join(root, "memory.json");
}

async function installLockDirectory(
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
    createdAt: new Date().toISOString(),
  });
}

async function ageLock(lockPath: string, ownerPath?: string): Promise<void> {
  const old = new Date(0);
  if (ownerPath) await utimes(ownerPath, old, old);
  await utimes(join(lockPath, "lease"), old, old).catch(() => undefined);
  await utimes(lockPath, old, old);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("memory store lock", () => {
  test("never reclaims a directory lock whose owner process is alive", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    const liveRecord = lockRecord(process.pid, LIVE_TOKEN);
    const ownerPath = await installLockDirectory(
      lockPath,
      LIVE_TOKEN,
      liveRecord,
    );
    await ageLock(lockPath, ownerPath);

    await expect(
      acquireStoreLock(storePath, {
        waitMs: 5,
        retryMs: 1,
        processIsAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "memory_store_busy" });
    await expect(readFile(ownerPath, "utf8")).resolves.toBe(liveRecord);
  });

  test("fails safely without reclaiming a legacy file lock", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    const legacyRecord = lockRecord(123, DEAD_TOKEN);
    await writeFile(lockPath, legacyRecord, "utf8");
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(
      acquireStoreLock(storePath, {
        waitMs: 5,
        retryMs: 1,
        processIsAlive: () => false,
      }),
    ).rejects.toMatchObject({ code: "memory_store_busy" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(legacyRecord);
  });

  test("reclaims a directory lock only after its recorded owner is dead", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    await installLockDirectory(
      lockPath,
      DEAD_TOKEN,
      lockRecord(123, DEAD_TOKEN),
    );

    const release = await acquireStoreLock(storePath, {
      waitMs: 20,
      retryMs: 1,
      processIsAlive: () => false,
    });
    await release();
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["empty", "partial"])(
    "recovers an old %s lock directory",
    async (kind) => {
      const storePath = await createStorePath();
      const lockPath = `${storePath}.lock`;
      let ownerPath: string | undefined;
      if (kind === "empty") {
        await mkdir(lockPath, { mode: 0o700 });
      } else {
        ownerPath = await installLockDirectory(
          lockPath,
          PARTIAL_TOKEN,
          '{"pid":123,"token":"abandoned',
        );
      }
      await ageLock(lockPath, ownerPath);

      const release = await acquireStoreLock(storePath, {
        waitMs: 20,
        retryMs: 1,
        processIsAlive: () => false,
      });
      await release();

      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("does not age-break an incomplete record with a confirmed live owner", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    const incompleteRecord = JSON.stringify({ pid: process.pid });
    const ownerPath = await installLockDirectory(
      lockPath,
      PARTIAL_TOKEN,
      incompleteRecord,
    );
    await ageLock(lockPath, ownerPath);

    await expect(
      acquireStoreLock(storePath, {
        waitMs: 5,
        retryMs: 1,
        processIsAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "memory_store_busy" });
    await expect(readFile(ownerPath, "utf8")).resolves.toBe(incompleteRecord);
  });

  test("removes its staging directory when writing the owner record fails", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    const probePath = `${storePath}.probe`;
    const probe = await open(probePath, "w");
    const handlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    const writeFileOriginal = handlePrototype.writeFile;
    await probe.close();
    await rm(probePath);
    vi.spyOn(handlePrototype, "writeFile").mockImplementationOnce(
      async function (this: FileHandle) {
        await writeFileOriginal.call(this, '{"pid":');
        throw Object.assign(new Error("forced lock-record write failure"), {
          code: "EIO",
        });
      },
    );

    await expect(acquireStoreLock(storePath)).rejects.toMatchObject({
      code: "memory_store_unavailable",
    });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(dirname(storePath))).resolves.toEqual([]);

    const release = await acquireStoreLock(storePath);
    await release();
  });

  test("an old owner cannot delete a replacement lock", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    const release = await acquireStoreLock(storePath);
    await rm(lockPath, { force: true, recursive: true });
    const replacement = lockRecord(process.pid, REPLACEMENT_TOKEN);
    const replacementOwner = await installLockDirectory(
      lockPath,
      REPLACEMENT_TOKEN,
      replacement,
    );

    await release();
    await expect(readFile(replacementOwner, "utf8")).resolves.toBe(replacement);
  });

  test("a stale reaper cannot delete a replacement installed after its snapshot", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    const staleOwner = await installLockDirectory(
      lockPath,
      DEAD_TOKEN,
      lockRecord(123, DEAD_TOKEN),
    );
    const replacementOwner = join(
      lockPath,
      "lease",
      ownerFileName(REPLACEMENT_TOKEN),
    );
    const replacementRecord = lockRecord(process.pid, REPLACEMENT_TOKEN);
    let replacementInstalled = false;

    await expect(
      acquireStoreLock(storePath, {
        waitMs: 5,
        retryMs: 1,
        processIsAlive: (pid) => {
          if (pid === 123 && !replacementInstalled) {
            unlinkSync(staleOwner);
            rmdirSync(join(lockPath, "lease"));
            rmdirSync(lockPath);
            mkdirSync(join(lockPath, "lease"), {
              mode: 0o700,
              recursive: true,
            });
            writeFileSync(replacementOwner, replacementRecord, {
              encoding: "utf8",
              mode: 0o600,
            });
            replacementInstalled = true;
            return false;
          }
          return pid === process.pid;
        },
      }),
    ).rejects.toMatchObject({ code: "memory_store_busy" });

    expect(replacementInstalled).toBe(true);
    await expect(readFile(replacementOwner, "utf8")).resolves.toBe(
      replacementRecord,
    );
  });

  test("concurrent stale reapers allow only one new owner", async () => {
    const storePath = await createStorePath();
    const lockPath = `${storePath}.lock`;
    await installLockDirectory(
      lockPath,
      DEAD_TOKEN,
      lockRecord(123, DEAD_TOKEN),
    );

    const contenders = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        acquireStoreLock(storePath, {
          waitMs: 20,
          retryMs: 1,
          processIsAlive: (pid) => pid === process.pid,
        }),
      ),
    );
    const acquired = contenders.filter(
      (result): result is PromiseFulfilledResult<() => Promise<void>> =>
        result.status === "fulfilled",
    );
    expect(acquired).toHaveLength(1);
    for (const result of contenders) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "memory_store_busy" });
      }
    }
    await acquired[0]?.value();
  });
});
