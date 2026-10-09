import type { SessionMetadata } from "../../sessions/metadata/projection.js";

export type SessionPageQuery = {
  cursor?: string | null; query?: string; archived?: boolean;
  pinnedSessionIds?: string[]; orderedSessionIds?: string[]; archivedSessionIds?: string[];
};
type SortKey = [number, number, number, string];

function compareKeys(left: SortKey, right: SortKey): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3].localeCompare(right[3]);
}
function readCursor(cursor: string): SortKey {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!Array.isArray(key) || key.length !== 4) throw new Error();
    if (!key.slice(0, 3).every(Number.isFinite) || typeof key[3] !== "string") throw new Error();
    return key as SortKey;
  } catch { throw new Error("session_cursor_invalid"); }
}
function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

export function sessionMetadataPage(records: SessionMetadata[], input: SessionPageQuery, limit: number) {
  const archived = new Set(readIds(input.archivedSessionIds));
  const pinned = new Map(readIds(input.pinnedSessionIds).map((id, index) => [id, index]));
  const ordered = new Map(readIds(input.orderedSessionIds).map((id, index) => [id, index]));
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const archivedCount = records.filter(({ summary }) => archived.has(summary.id)).length;
  const entries = records.filter(({ summary }) => archived.has(summary.id) === (input.archived === true))
    .filter(({ summary }) => [summary.id, summary.title, summary.lastMessagePreview].some((text) => text.toLowerCase().includes(query)))
    .map((record) => {
      const { id, updatedAt } = record.summary;
      const key: SortKey = [pinned.has(id) ? 0 : 1, pinned.get(id) ?? ordered.get(id) ?? -1, -updatedAt, id];
      return { record, key };
    }).sort((left, right) => compareKeys(left.key, right.key));
  const anchor = input.cursor ? readCursor(input.cursor) : null;
  const remaining = anchor ? entries.filter(({ key }) => compareKeys(key, anchor) > 0) : entries;
  const page = remaining.slice(0, limit);
  return {
    records: page.map(({ record }) => record), total: entries.length, archivedCount,
    nextCursor: remaining.length > limit ? Buffer.from(JSON.stringify(page.at(-1)!.key)).toString("base64url") : null,
  };
}
