import { createHash } from "node:crypto";
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectChangesAuthority } from "./access.js";
import { PROJECT_CHANGE_LIMIT, PROJECT_FILE_BYTES, PROJECT_IDENTITY_BYTES, ProjectChangesError, type ProjectChangeFile, type ProjectChangePreview, type ProjectChanges, type ProjectChangeStatus } from "./contracts.js";
import { projectFileId, readProjectContent, readProjectFileState, type ProjectFileState } from "./file-state.js";
import { requireGitRead } from "./git-process.js";
import { compareProjectText, type TextComparison } from "./line-diff.js";
import { indexMatchesFile, readProjectMetadata, type ProjectTreeEntry, type ProjectIndexEntry } from "./metadata.js";
import { normalizeProjectContent, readProjectAttributes, type ProjectAttributes } from "./normalization.js";
import type { ProjectGitRepository } from "./repository.js";

export type ProjectChangesSnapshot = { changes: ProjectChanges; previews: Map<string, ProjectChangePreview>; versions: Map<string, ProjectFileState>; attributes: Map<string, ProjectAttributes> };
/** Internal root identity remains authoritative but is never user-facing Git content. */
export function isInternalProjectFile(path: string): boolean {
  return path === ".abot-file-output-root";
}
export function requireProjectChangesActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProjectChangesError("project_changes_unavailable", "The changes request exceeded its time limit or was cancelled.", 503);
}
function currentMode(state: ProjectFileState, fileMode: boolean, recordedMode?: string): string | null {
  if (state.kind === "missing") return null;
  if (!fileMode) return recordedMode === "100755" ? "100755" : "100644";
  return (Number(state.identity?.[5] ?? "0") & 0o100) === 0 ? "100644" : "100755";
}
async function readBase(repository: ProjectGitRepository, entry: ProjectTreeEntry | undefined): Promise<{ status: "text"; text: string } | { status: "binary" | "too_large" }> {
  if (!entry) return { status: "text", text: "" };
  if (entry.size > PROJECT_FILE_BYTES) return { status: "too_large" };
  const bytes = requireGitRead(await repository.git(["cat-file", "blob", entry.oid], { maxBytes: PROJECT_FILE_BYTES }));
  if (bytes.includes(0)) return { status: "binary" };
  try { return { status: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { return { status: "binary" }; }
}
async function unchangedSymbolicLink(directory: string, path: string, entry: ProjectTreeEntry | undefined): Promise<boolean> {
  if (entry?.mode !== "120000") return false;
  try {
    const link = await readlink(join(directory, path), { encoding: "buffer" });
    return createHash(entry.oid.length === 64 ? "sha256" : "sha1").update(`blob ${link.length}\0`).update(link).digest("hex") === entry.oid;
  } catch { return false; }
}
function isUnsupportedTreeEntry(entry: ProjectTreeEntry | undefined): boolean {
  return !!entry && entry.mode !== "100644" && entry.mode !== "100755";
}
function isUnchangedIndexedFile(entry: ProjectTreeEntry | undefined, index: ProjectIndexEntry | undefined, state: ProjectFileState, indexMtimeNs: bigint | null): boolean {
  return !!entry && index?.oid === entry.oid && index.mode === entry.mode && indexMatchesFile(index, state, indexMtimeNs);
}
function isUnchangedSubmodule(entry: ProjectTreeEntry | undefined, index: ProjectIndexEntry | undefined, state: ProjectFileState): boolean {
  return entry?.mode === "160000" && index?.oid === entry.oid && state.kind === "unsupported";
}
function changeStatus(entry: ProjectTreeEntry | undefined, index: ProjectIndexEntry | undefined, state: ProjectFileState): ProjectChangeStatus {
  if (index?.conflict) return "conflicted";
  if (!entry) return index ? "added" : "untracked";
  if (state.kind === "missing") return "deleted";
  if (isUnsupportedTreeEntry(entry) || state.kind === "unsupported") return "type_changed";
  return "modified";
}
function hasConflictWithoutHeadDifference(before: string, after: string, oldMode: string | null, newMode: string | null, conflicted: boolean): boolean {
  if (!conflicted) return false;
  if (before !== after) return false;
  return oldMode === newMode;
}
function compareProjectChange(path: string, before: string, after: string, oldMode: string | null, newMode: string | null, conflicted: boolean): TextComparison | { status: "unavailable"; message: string } {
  if (hasConflictWithoutHeadDifference(before, after, oldMode, newMode, conflicted))
    return { status: "unavailable", message: "The index contains an unresolved conflict; the current file matches HEAD, so no text difference is available." };
  return compareProjectText(path, before, after, oldMode, newMode);
}
export async function readProjectChangesSnapshot(authority: ProjectChangesAuthority, repository: ProjectGitRepository, signal?: AbortSignal): Promise<ProjectChangesSnapshot> {
  const metadata = await readProjectMetadata(repository);
  const files: ProjectChangeFile[] = [];
  const previews = new Map<string, ProjectChangePreview>();
  const versions = new Map<string, ProjectFileState>();
  const selected: string[] = [];
  for (const path of metadata.paths) {
    requireProjectChangesActive(signal);
    const entry = metadata.tree.get(path);
    const index = metadata.index.get(path);
    const state = await readProjectFileState(authority.directory, path);
    versions.set(path, state);
    if (isInternalProjectFile(path)) continue;
    if (!entry && state.kind === "missing") continue;
    if (isUnchangedIndexedFile(entry, index, state, repository.indexMtimeNs)) continue;
    if (isUnchangedSubmodule(entry, index, state)) continue;
    if (state.leafSymlink && await unchangedSymbolicLink(authority.directory, path, entry)) continue;
    selected.push(path);
  }
  const attributes = await readProjectAttributes(repository, selected);
  let totalFiles = 0;
  let readBytes = 0;
  for (const path of selected) {
    requireProjectChangesActive(signal);
    const entry = metadata.tree.get(path);
    const index = metadata.index.get(path);
    const state = versions.get(path)!;
    const mode = currentMode(state, repository.fileMode, index?.mode ?? entry?.mode);
    const unsupportedEntry = isUnsupportedTreeEntry(entry);
    readBytes += state.kind === "file" && state.size <= PROJECT_IDENTITY_BYTES ? state.size : 0;
    if (readBytes > 32 * 1024 * 1024) throw new ProjectChangesError("project_changes_unavailable", "This project exceeds the bounded comparison size.");
    const raw = state.kind === "file" && !unsupportedEntry
      ? await readProjectContent(authority.directory, path, repository.head?.length === 64 ? "sha256" : "sha1", signal)
      : state.kind === "missing" ? { status: "text" as const, text: "", hash: "" } : { status: "unavailable" as const };
    const content = await normalizeProjectContent(repository, attributes.get(path)!, raw, index);
    if (entry && "hash" in content && content.hash === entry.oid && mode === entry.mode && !index?.conflict) continue;
    totalFiles++;
    if (files.length >= PROJECT_CHANGE_LIMIT) continue;
    const id = projectFileId(authority.rootIdentity, path);
    const status = changeStatus(entry, index, state);
    let preview: ProjectChangePreview = { id, path, status: content.status, patch: null, ...(content.status === "unavailable" ? { message: "This file uses an unsupported encoding or identity transformation." } : {}) };
    let additions: number | null = null;
    let deletions: number | null = null;
    if (unsupportedEntry || state.kind === "unsupported") preview = { id, path, status: "unavailable", patch: null, message: "Symbolic links, submodules, and non-regular files are not previewed." };
    else if (content.status === "text") {
      const before = await readBase(repository, entry);
      if (before.status === "text") {
        const comparison = compareProjectChange(path, before.text, content.text, entry?.mode ?? null, mode, index?.conflict === true);
        preview = { id, path, status: comparison.status, patch: comparison.status === "text" ? comparison.patch : null, ...("message" in comparison ? { message: comparison.message } : {}) };
        if (comparison.status === "text") { additions = comparison.additions; deletions = comparison.deletions; }
      } else preview = { id, path, status: before.status, patch: null };
    }
    previews.set(id, preview);
    files.push({ id, path, status, additions, deletions, binary: preview.status === "binary" });
  }
  const truncated = totalFiles > PROJECT_CHANGE_LIMIT;
  const completeTotals = !truncated && files.every((file) => file.additions !== null && file.deletions !== null);
  const revision = createHash("sha256").update(JSON.stringify([authority.rootIdentity, repository.root, repository.head, repository.indexVersion, repository.fileMode, repository.autocrlf, repository.eol, [...attributes], [...metadata.tree], [...metadata.index], metadata.paths, [...versions]])).digest("hex");
  requireProjectChangesActive(signal);
  await authority.assertCurrent();
  return { changes: { status: "available", files, totalFiles, additions: completeTotals ? files.reduce((sum, file) => sum + file.additions!, 0) : null,
    deletions: completeTotals ? files.reduce((sum, file) => sum + file.deletions!, 0) : null, truncated, base: repository.head ? "head" : "empty", revision }, previews, versions, attributes };
}
