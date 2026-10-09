import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionRecord } from "../types.js";
import {
  compareSessionMetadata, isCurrentSessionMetadata, projectSessionMetadata,
  type SessionMetadata,
} from "./projection.js";
import {
  currentSourceStamp, isMissingSessionFile, publishSessionMetadata, publishSessionProjection, readMetadataJson,
  reportMetadataFailure, sessionSourceStamp, writeMetadataJson,
} from "./publication.js";
import { applySourceReceipt, writeSourceReceipt } from "./source-receipt.js";

export { currentSourceStamp, sessionSourceStamp } from "./publication.js";

const pendingLists = new Map<string, Promise<SessionMetadata[]>>();
const concurrentMetadataReads = 4;

function metadataPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, ".metadata", `${sessionId}.json`);
}

async function writeMetadata(sessionsDir: string, record: SessionMetadata): Promise<void> {
  const target = metadataPath(sessionsDir, record.summary.id);
  const sourcePath = join(sessionsDir, `${record.summary.id}.json`);
  await publishSessionProjection(target, async () => {
    if (!await writeMetadataJson(target, record, sourcePath, record.source)) return;
    // The full projection already carries its source; only request-only changes need a receipt.
    await rm(`${target}.source`, { force: true });
  });
}

/** The canonical session has already committed. A derived-index failure cannot undo it. */
export async function updateSessionMetadata(
  sessionsDir: string, session: SessionRecord, source: string, previousSource?: string | null,
): Promise<void> {
  if (previousSource) {
    const target = metadataPath(sessionsDir, session.id);
    return publishSessionMetadata(target, () => writeSourceReceipt(
      `${target}.source`, join(sessionsDir, `${session.id}.json`), source, session.updatedAt, previousSource,
    ));
  }
  try {
    await writeMetadata(sessionsDir, projectSessionMetadata(session, source));
  } catch (error) {
    reportMetadataFailure(session.id, error);
  }
}

export async function deleteSessionMetadata(sessionsDir: string, sessionId: string): Promise<void> {
  const target = metadataPath(sessionsDir, sessionId);
  await publishSessionProjection(target, async () => {
    await rm(target, { force: true });
    await rm(`${target}.source`, { force: true });
  });
}

async function readSourceMetadata(path: string): Promise<SessionMetadata | null> {
  const handle = await open(path, "r").catch((error: unknown) => {
    if (isMissingSessionFile(error)) return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const source = sessionSourceStamp(await handle.stat({ bigint: true }));
    const session = JSON.parse(await handle.readFile("utf8")) as SessionRecord;
    return projectSessionMetadata(session, source);
  } finally {
    await handle.close();
  }
}

async function readCurrentMetadata(target: string, sessionId: string, source: string): Promise<SessionMetadata | null> {
  const stored = await readMetadataJson(target);
  if (isCurrentSessionMetadata(stored, sessionId, source)) return stored;
  const projectionSource = (stored as SessionMetadata | null)?.source;
  if (typeof projectionSource !== "string") return null;
  if (!isCurrentSessionMetadata(stored, sessionId, projectionSource)) return null;
  return applySourceReceipt(`${target}.source`, stored, source);
}

async function loadMetadata(sessionsDir: string, sessionId: string): Promise<SessionMetadata | null> {
  const path = join(sessionsDir, `${sessionId}.json`);
  const source = await currentSourceStamp(path);
  if (source === null) return null;
  const current = await readCurrentMetadata(metadataPath(sessionsDir, sessionId), sessionId, source);
  if (current) return current;
  const rebuilt = await readSourceMetadata(path);
  if (!rebuilt) return null;
  await writeMetadata(sessionsDir, rebuilt);
  return rebuilt;
}

function settledMetadata(result: PromiseSettledResult<SessionMetadata | null>): SessionMetadata | null {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

/**
 * Each atomically published record completes its own backfill. Restarts reuse
 * those records; interrupted backfills only rebuild missing/stale entries.
 * Source stamps also detect older writers and a crash between the two commits.
 */
async function readMetadataList(sessionsDir: string): Promise<SessionMetadata[]> {
  await mkdir(sessionsDir, { recursive: true });
  const names = (await readdir(sessionsDir)).filter((name) => name.endsWith(".json"));
  const records: SessionMetadata[] = [];
  for (let offset = 0; offset < names.length; offset += concurrentMetadataReads) {
    // Bound disk fan-out and drain the batch before propagating a canonical read failure.
    const batch = await Promise.allSettled(names.slice(offset, offset + concurrentMetadataReads)
      .map((name) => loadMetadata(sessionsDir, name.slice(0, -5))));
    records.push(...batch.map(settledMetadata).filter((record) => record !== null));
  }
  return records.sort(compareSessionMetadata);
}

export async function listSessionMetadata(sessionsDir: string): Promise<SessionMetadata[]> {
  const directory = resolve(sessionsDir);
  const existing = pendingLists.get(directory);
  if (existing) return existing;
  const pending = readMetadataList(directory);
  pendingLists.set(directory, pending);
  try {
    return await pending;
  } finally {
    pendingLists.delete(directory);
  }
}
