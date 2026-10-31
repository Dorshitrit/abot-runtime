import { ProjectChangesError } from "./contracts.js";
import type { ProjectFileState } from "./file-state.js";
import { requireGitRead } from "./git-process.js";
import { isProjectRelativePath, type ProjectGitRepository } from "./repository.js";

export type ProjectTreeEntry = { path: string; oid: string; mode: string; size: number };
export type ProjectIndexEntry = { oid: string; mode: string; conflict: boolean; identity: readonly string[] };
export type ProjectMetadata = { tree: Map<string, ProjectTreeEntry>; index: Map<string, ProjectIndexEntry>; paths: string[] };
function records(bytes: Buffer): string[] { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).split("\0").filter(Boolean); }
function scopedPath(path: string): string {
  if (!isProjectRelativePath(path)) throw new ProjectChangesError("project_changes_unavailable", "Git returned an unsupported project path.");
  return path;
}
function isFileModificationOlderThanIndex(state: ProjectFileState, indexMtimeNs: bigint | null): boolean {
  if (indexMtimeNs === null) return false;
  const mtimeNs = state.identity?.[1];
  if (mtimeNs === undefined) return false;
  return BigInt(mtimeNs) < indexMtimeNs;
}
export function indexMatchesFile(index: ProjectIndexEntry | undefined, state: ProjectFileState, indexMtimeNs: bigint | null): boolean {
  if (!index || index.conflict) return false;
  if (state.kind !== "file") return false;
  if (!isFileModificationOlderThanIndex(state, indexMtimeNs)) return false;
  return index.identity.every((value, position) => value === state.identity?.[position]);
}
function isUntrackedFileRecord(path: string): boolean {
  return !path.endsWith("/");
}
export async function readProjectMetadata(repository: ProjectGitRepository): Promise<ProjectMetadata> {
  const tree = new Map<string, ProjectTreeEntry>();
  if (repository.head) {
    const bytes = requireGitRead(await repository.git(["ls-tree", "-r", "-z", "-l", repository.head, "--", "."]));
    for (const record of records(bytes)) {
      const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/u.exec(record);
      if (!match) throw new ProjectChangesError("project_changes_unavailable", "Git returned unsupported tree metadata.");
      const path = scopedPath(match[4]!);
      tree.set(path, { path, oid: match[2]!, mode: match[1]!, size: match[3] === "-" ? 0 : Number(match[3]) });
    }
  }
  const index = new Map<string, ProjectIndexEntry>();
  const bytes = requireGitRead(await repository.git(["ls-files", "--stage", "--debug", "-z", "--", "."]));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0;
  while (offset < text.length) {
    const nul = text.indexOf("\0", offset);
    const entry = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(text.slice(offset, nul));
    const debug = /^  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: \d+\tgid: \d+\n  size: (\d+)\tflags: [a-f0-9]+\n/u.exec(text.slice(nul + 1));
    if (nul < 0 || !entry || !debug) throw new ProjectChangesError("project_changes_unavailable", "Git index metadata is unsupported.");
    const path = scopedPath(entry[4]!);
    const nanoseconds = (seconds: string, nanos: string) => String(BigInt(seconds) * 1000000000n + BigInt(nanos));
    index.set(path, { oid: entry[2]!, mode: entry[1]!, conflict: entry[3] !== "0" || index.get(path)?.conflict === true,
      identity: [nanoseconds(debug[1]!, debug[2]!), nanoseconds(debug[3]!, debug[4]!), debug[5]!, debug[6]!, debug[7]!, String(parseInt(entry[1]!, 8) & 0o111)] });
    offset = nul + 1 + debug[0].length;
  }
  const other = records(requireGitRead(await repository.git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]))).filter(isUntrackedFileRecord).map(scopedPath);
  const paths = [...new Set([...tree.keys(), ...index.keys(), ...other])].sort();
  if (paths.length > 20000) throw new ProjectChangesError("project_changes_unavailable", "This project exceeds the bounded file scan limit.");
  return { tree, index, paths };
}
