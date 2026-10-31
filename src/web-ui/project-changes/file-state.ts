import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedRegularFile } from "../../plugin-sdk/files.js";
import { PROJECT_FILE_BYTES, PROJECT_IDENTITY_BYTES, ProjectChangesError } from "./contracts.js";
import { isProjectRelativePath } from "./repository.js";

export type ProjectFileState = { version: string; kind: "file" | "missing" | "unsupported"; size: number; identity?: readonly string[]; leafSymlink?: boolean };
export async function readProjectFileState(directory: string, path: string): Promise<ProjectFileState> {
  if (!isProjectRelativePath(path)) throw new ProjectChangesError("project_changes_reference_invalid", "Invalid project file.");
  const parts = path.split("/");
  let current = directory;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try { info = await lstat(current, { bigint: true }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { version: "missing", kind: "missing", size: 0 };
      throw error;
    }
    const version = [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
    if (info.isSymbolicLink()) return { version, kind: "unsupported", size: Number(info.size), leafSymlink: index === parts.length - 1 };
    if (index < parts.length - 1) {
      if (!info.isDirectory()) return { version, kind: "unsupported", size: Number(info.size) };
      continue;
    }
    if (!info.isFile()) return { version, kind: "unsupported", size: Number(info.size) };
    if (await realpath(current) !== current) return { version, kind: "unsupported", size: Number(info.size) };
    return { version, kind: "file", size: Number(info.size), identity: [info.ctimeNs, info.mtimeNs, info.dev & 0xffffffffn, info.ino & 0xffffffffn, info.size, info.mode & 0o111n].map(String) };
  }
  throw new ProjectChangesError("project_changes_reference_invalid", "Invalid project file.");
}

export type ProjectContent = { status: "text"; text: string; hash: string } | { status: "binary"; hash: string } | { status: "too_large"; hash: string; text?: string } | { status: "unavailable" };
export async function readProjectContent(directory: string, path: string, algorithm: "sha1" | "sha256", signal?: AbortSignal): Promise<ProjectContent> {
  const state = await readProjectFileState(directory, path);
  if (state.kind !== "file") return { status: "unavailable" };
  // Identity reads may exceed the text limit; they still have a fixed memory bound.
  if (state.size > PROJECT_IDENTITY_BYTES) return { status: "too_large", hash: "" };
  const result = await readBoundedRegularFile(join(directory, path), { rootPath: directory, maxBytes: PROJECT_IDENTITY_BYTES, ...(signal ? { signal } : {}) });
  if (!result.ok) throw new ProjectChangesError("project_changes_stale", "The project file changed during its read.", 409);
  const hash = createHash(algorithm).update(`blob ${result.bytes.length}\0`).update(result.bytes).digest("hex");
  if (result.bytes.includes(0)) return { status: "binary", hash };
  try { return { status: result.bytes.length > PROJECT_FILE_BYTES ? "too_large" : "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.bytes), hash }; }
  catch { return { status: "binary", hash }; }
}
export function projectFileId(rootIdentity: string, path: string): string {
  return createHash("sha256").update(JSON.stringify([rootIdentity, path])).digest("hex");
}
export function textLineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - Number(text.endsWith("\n"));
}
