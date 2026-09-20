import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalConfigFilePath } from "../../runtime/adapters/config-file-transaction.js";
import { withFileLock } from "../../runtime/adapters/long-term-memory/file-lock.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

export class MalformedRuntimeSetupReceiptError extends RuntimeSetupError {
  constructor() {
    super(
      "setup_configuration_changed",
      "The unfinished setup receipt is invalid. Refresh to start setup again.",
      409,
    );
  }
}

function receiptFileChanged(): RuntimeSetupError {
  return new RuntimeSetupError(
    "setup_configuration_changed",
    "The unfinished setup receipt changed. Refresh before saving again.",
    409,
  );
}

function isMissingReceipt(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readReceiptFile(
  path: string,
): Promise<{ raw?: Buffer; mode: number }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw receiptFileChanged();
    return { raw: await readFile(path), mode: info.mode & 0o777 };
  } catch (error) {
    if (isMissingReceipt(error)) return { mode: 0o600 };
    throw error;
  }
}

export async function runtimeSetupReceiptPath(
  configPath: string,
): Promise<string> {
  const path = `${await canonicalConfigFilePath(configPath)}.web-setup.json`;
  await readReceiptFile(path);
  return path;
}

export async function readRuntimeSetupReceipt(
  configPath: string,
): Promise<string | undefined> {
  const path = await runtimeSetupReceiptPath(configPath);
  return (await readReceiptFile(path)).raw?.toString("utf8");
}

async function requireUnchangedReceipt(
  path: string,
  previous: Buffer | undefined,
): Promise<void> {
  const current = (await readReceiptFile(path)).raw;
  if (current === undefined && previous === undefined) return;
  if (current === undefined) throw receiptFileChanged();
  if (previous === undefined) throw receiptFileChanged();
  if (!current.equals(previous)) throw receiptFileChanged();
}

/** Receipt storage compares raw bytes so a malformed sidecar can be backed up and replaced. */
export async function writeRuntimeSetupReceipt(
  configPath: string,
  receipt: object,
): Promise<void> {
  const path = await runtimeSetupReceiptPath(configPath);
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(`${path}.config.lock`, async () => {
    const previous = await readReceiptFile(path);
    const token = randomUUID();
    const temporary = `${path}.${token}.tmp`;
    const backup = `${path}.${new Date().toISOString().replace(/[:.]/gu, "-")}.${token}.bak`;
    try {
      if (previous.raw !== undefined)
        await writeFile(backup, previous.raw, {
          mode: previous.mode,
          flag: "wx",
        });
      await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", {
        mode: previous.mode,
        flag: "wx",
      });
      await requireUnchangedReceipt(path, previous.raw);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
