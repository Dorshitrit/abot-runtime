import { toEpochMs } from "../record/projection.js";
import type { SessionMetadata } from "./projection.js";
import { readMetadataJson, writeMetadataJson } from "./publication.js";

export type SessionMetadataChange = "projection" | "request-only";

type SessionSourceReceipt = {
  version: 1;
  source: string;
  projectionSource: string;
  updatedAt: string;
};

function isSourceReceipt(value: unknown): value is SessionSourceReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as SessionSourceReceipt;
  if (receipt.version !== 1) return false;
  if (typeof receipt.source !== "string") return false;
  if (typeof receipt.projectionSource !== "string") return false;
  return typeof receipt.updatedAt === "string";
}

async function receiptProjectionSource(path: string, source: string, previousSource?: string): Promise<string> {
  if (previousSource === undefined) return source;
  const previous = await readMetadataJson(path);
  if (!isSourceReceipt(previous)) return previousSource;
  if (previous.source !== previousSource) return previousSource;
  return previous.projectionSource;
}

export async function writeSourceReceipt(
  path: string, sourcePath: string, source: string, updatedAt: string, previousSource?: string,
): Promise<void> {
  const projectionSource = await receiptProjectionSource(path, source, previousSource);
  await writeMetadataJson(path, { version: 1, source, projectionSource, updatedAt }, sourcePath, source);
}

/** Bind request-only changes to the exact projection they left unchanged. */
export async function applySourceReceipt(
  path: string, record: SessionMetadata, source: string,
): Promise<SessionMetadata | null> {
  const receipt = await readMetadataJson(path);
  if (!isSourceReceipt(receipt)) return null;
  if (receipt.source !== source) return null;
  if (receipt.projectionSource !== record.source) return null;
  return {
    ...record, source, updatedAt: receipt.updatedAt,
    summary: { ...record.summary, updatedAt: toEpochMs(receipt.updatedAt) },
  };
}
