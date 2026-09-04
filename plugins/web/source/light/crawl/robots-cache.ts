import type { RobotsDocument } from "./robots-parser.js";

type CachedRobots = Readonly<{
  document: RobotsDocument;
  expiresAt: number;
  bytes: number;
}>;

const MAX_ROBOTS_CACHE_BYTES = 4 * 1_024 * 1_024;
const MAX_ROBOTS_CACHE_ENTRIES = 64;

function estimatedRobotsBytes(
  origin: string,
  document: RobotsDocument,
): number {
  const ruleBytes = document.rules.reduce(
    (sum, rule) => sum + rule.path.length * 2 + 96,
    0,
  );
  const sitemapBytes = document.sitemaps.reduce(
    (sum, url) => sum + url.length * 2 + 32,
    0,
  );
  return origin.length * 2 + ruleBytes + sitemapBytes + 128;
}

export function createRobotsCache() {
  const entries = new Map<string, CachedRobots>();
  let bytes = 0;
  const remove = (origin: string) => {
    const entry = entries.get(origin);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(origin);
  };
  const exceedsRobotsCacheCapacity = (incomingBytes: number) => {
    if (entries.size >= MAX_ROBOTS_CACHE_ENTRIES) return true;
    return bytes + incomingBytes > MAX_ROBOTS_CACHE_BYTES;
  };
  return Object.freeze({
    get(origin: string): RobotsDocument | undefined {
      const entry = entries.get(origin);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        remove(origin);
        return undefined;
      }
      entries.delete(origin);
      entries.set(origin, entry);
      return entry.document;
    },
    set(origin: string, document: RobotsDocument, ttlMs: number) {
      remove(origin);
      const entryBytes = estimatedRobotsBytes(origin, document);
      if (ttlMs <= 0) return;
      if (entryBytes > MAX_ROBOTS_CACHE_BYTES) return;
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= Date.now()) remove(key);
      }
      while (exceedsRobotsCacheCapacity(entryBytes)) {
        remove(entries.keys().next().value!);
      }
      entries.set(origin, {
        document,
        bytes: entryBytes,
        expiresAt: Date.now() + ttlMs,
      });
      bytes += entryBytes;
    },
  });
}
