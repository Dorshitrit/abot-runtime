import { sep } from "node:path";

type DiscoveredModelIdentity = { id: string; path: string };

function canPreserveDiscoveredModelId(
  id: string,
  counts: ReadonlyMap<string, number>,
  configuredIds: ReadonlySet<string>,
): boolean {
  if (!id) return false;
  if (id.trim() !== id) return false;
  if (counts.get(id) !== 1) return false;
  return !configuredIds.has(id);
}

function availableModelPathId(
  path: string,
  reserved: ReadonlySet<string>,
): string {
  const encodedPath = path.split(sep).map(encodeURIComponent).join("/");
  let id = `file:${encodedPath}`;
  while (reserved.has(id)) id = `file:${id}`;
  return id;
}

function compareDiscoveredModelIds(
  left: DiscoveredModelIdentity,
  right: DiscoveredModelIdentity,
): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/** Dashboard-only file identities never rename configured Runtime profiles. */
export function assignDiscoveredModelIds<T extends DiscoveredModelIdentity>(
  configuredIds: readonly string[],
  discovered: readonly T[],
): T[] {
  const configured = new Set(configuredIds);
  const counts = new Map<string, number>();
  for (const { id } of discovered) counts.set(id, (counts.get(id) ?? 0) + 1);
  const preserved = new Set(
    discovered
      .filter(({ id }) => canPreserveDiscoveredModelId(id, counts, configured))
      .map(({ id }) => id),
  );
  // Reserve all ordinary names first, independent of filesystem iteration order.
  const reserved = new Set([...configured, ...preserved]);
  return discovered
    .map((ref) => {
      if (preserved.has(ref.id)) return ref;
      const id = availableModelPathId(ref.path, reserved);
      reserved.add(id);
      return { ...ref, id };
    })
    .sort(compareDiscoveredModelIds);
}
