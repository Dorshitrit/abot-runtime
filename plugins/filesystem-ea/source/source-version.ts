/** Compare content separately from destination identity/access. Read and commit
 * snapshots retain their full metadata for the existing final race checks.
 * Keep serialized versions intact so pending approval fingerprints also survive.
 */
export function sameSourceVersion(expected: string, observed: string): boolean {
  if (expected === observed) return true;
  try {
    const before: unknown = JSON.parse(expected);
    const after: unknown = JSON.parse(observed);
    if (!isFileVersion(before) || !isFileVersion(after)) return false;
    if (!hasSameContentRevision(before, after)) return false;
    return hasSameDestinationAccess(before, after);
  } catch { return false; }
}

function isFileVersion(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "file";
}

function hasSameContentRevision(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return typeof before.digest === "string" && before.digest === after.digest && before.size === after.size;
}

function hasSameDestinationAccess(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return before.device === after.device && before.inode === after.inode && before.mode === after.mode;
}
