import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileLock } from "../../runtime/adapters/long-term-memory/file-lock.js";

const pendingPublications = new Map<string, Promise<void>>();

export function isMissingSessionFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function sessionSourceStamp(source: BigIntStats): string {
  return `${source.dev}:${source.ino}:${source.size}:${source.mtimeNs}`;
}

export async function currentSourceStamp(path: string): Promise<string | null> {
  try {
    return sessionSourceStamp(await stat(path, { bigint: true }));
  } catch (error) {
    if (isMissingSessionFile(error)) return null;
    throw error;
  }
}

export function reportMetadataFailure(sessionId: string, error: unknown): void {
  process.emitWarning(`Session metadata update failed for ${sessionId}: ${String(error)}`, {
    code: "SESSION_METADATA_WRITE_FAILED",
  });
}

/** Only the derived index is expendable; canonical session read failures still propagate. */
export async function readMetadataJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingSessionFile(error)) return null;
    if (error instanceof SyntaxError) return null;
    reportMetadataFailure(path, error);
    return null;
  }
}

/** Serialize index publication/deletion by session, never across unrelated sessions. */
export async function publishSessionMetadata(path: string, operation: () => Promise<void>): Promise<void> {
  const key = resolve(path);
  const previous = pendingPublications.get(key) ?? Promise.resolve();
  const pending = previous.then(operation).catch((error: unknown) => reportMetadataFailure(path, error));
  pendingPublications.set(key, pending);
  try {
    await pending;
  } finally {
    if (pendingPublications.get(key) === pending) pendingPublications.delete(key);
  }
}

/** List backfills and the Runtime owner may run in different processes. */
export async function publishSessionProjection(path: string, operation: () => Promise<void>): Promise<void> {
  return publishSessionMetadata(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await withFileLock(`${path}.lock`, operation);
  });
}

export async function writeMetadataJson(
  target: string, value: unknown, sourcePath: string, source: string,
): Promise<boolean> {
  if (await currentSourceStamp(sourcePath) !== source) return false;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    // Validate at publication too: the canonical file may change while writing the temporary.
    if (await currentSourceStamp(sourcePath) !== source) return false;
    await rename(temporary, target);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}
