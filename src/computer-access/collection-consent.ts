import { join } from "node:path";
import { ensurePrivateRuntimeDirectory } from "../runtime/local-host/private-directory.js";
import {
  hostStateDirectory,
  readHostPrivateJson,
  writeHostPrivateJson,
} from "./companion/private-store.js";

export type CollectionConsent = Readonly<{
  accepted: boolean;
  acceptedAt?: string;
}>;

type CollectionConsentRecord = { version: 1; acceptedAt: string };

function isSavedCollectionConsent(value: unknown): value is CollectionConsentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (typeof record.acceptedAt !== "string") return false;
  return Number.isFinite(Date.parse(record.acceptedAt));
}

function collectionConsentPath(rootDir: string): string {
  return join(hostStateDirectory(rootDir), "collection-consent.json");
}

/** Installation data, shared across environments and independent of app versions or pairing. */
export function readCollectionConsent(rootDir: string): CollectionConsent {
  let record: unknown;
  try {
    record = readHostPrivateJson(collectionConsentPath(rootDir));
  } catch (error) {
    // A malformed record never authorizes collection. Filesystem safety errors remain visible.
    if (error instanceof SyntaxError) return { accepted: false };
    throw error;
  }
  if (!isSavedCollectionConsent(record)) return { accepted: false };
  return { accepted: true, acceptedAt: record.acceptedAt };
}

/** Acknowledgment records awareness only; it does not change activity permissions or start collection. */
export async function acceptCollectionConsent(rootDir: string): Promise<CollectionConsent> {
  await ensurePrivateRuntimeDirectory(hostStateDirectory(rootDir));
  const existing = readCollectionConsent(rootDir);
  if (existing.accepted) return existing;
  const acceptedAt = new Date().toISOString();
  writeHostPrivateJson(collectionConsentPath(rootDir), { version: 1, acceptedAt });
  return { accepted: true, acceptedAt };
}

export function requireCollectionConsent(rootDir: string): void {
  if (readCollectionConsent(rootDir).accepted) return;
  throw new Error("collection_consent_required");
}
