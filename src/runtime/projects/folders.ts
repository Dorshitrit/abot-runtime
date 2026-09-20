import { homedir } from "node:os";
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { ProjectOperationError, type ProjectFolderPage } from "./contracts.js";

function isAbsoluteProjectDirectory(input: unknown): input is string {
  if (typeof input !== "string") return false;
  if (!input.trim()) return false;
  return isAbsolute(input);
}

export async function resolveProjectDirectory(input: string): Promise<string> {
  if (!isAbsoluteProjectDirectory(input))
    throw new ProjectOperationError(
      "project_directory_absolute_required",
      "Choose an absolute folder path on this Runtime host.",
    );
  if (input.includes("\0"))
    throw new ProjectOperationError(
      "project_directory_invalid",
      "The folder path is invalid.",
    );
  try {
    const canonical = await realpath(input);
    if (!(await directoryExists(canonical)))
      throw new ProjectOperationError(
        "project_directory_required",
        "Choose a directory.",
      );
    return canonical;
  } catch (error) {
    if (error instanceof ProjectOperationError) throw error;
    throw new ProjectOperationError(
      "project_directory_unavailable",
      "This folder is unavailable to the Runtime host.",
      404,
    );
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isProjectDirectoryEntry(
  child: Dirent,
  path: string,
): Promise<boolean> {
  if (child.isDirectory()) return true;
  if (!child.isSymbolicLink()) return false;
  return directoryExists(path);
}

function resolveFolderPageStart(
  names: readonly string[],
  cursor?: string,
): number {
  if (!cursor) return 0;
  const index = names.indexOf(cursor);
  if (index < 0)
    throw new ProjectOperationError(
      "project_folder_cursor_stale",
      "Folder contents changed. Browse this folder again.",
      409,
    );
  return index + 1;
}

async function initialProjectBrowserDirectory(
  defaultDirectory: string,
  selected?: string,
): Promise<string> {
  if (selected) return resolveProjectDirectory(selected);
  if (await directoryExists(defaultDirectory))
    return resolveProjectDirectory(defaultDirectory);
  return resolveProjectDirectory(homedir());
}

export async function browseProjectFolders(
  defaultDirectory: string,
  input: { path?: string; cursor?: string } = {},
): Promise<ProjectFolderPage> {
  const directory = await initialProjectBrowserDirectory(
    defaultDirectory,
    input.path,
  );
  const roots = [
    { label: "Default workspace", path: defaultDirectory },
    { label: "Home", path: homedir() },
    { label: "Desktop", path: join(homedir(), "Desktop") },
    { label: "Filesystem", path: parse(directory).root },
  ];
  const availableRoots = [];
  for (const root of roots) {
    if (await directoryExists(root.path)) availableRoots.push(root);
  }
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new ProjectOperationError(
      "project_directory_unreadable",
      "The Runtime host cannot list this folder.",
      403,
    );
  }
  const folders = [];
  for (const child of children) {
    const path = join(directory, child.name);
    if (await isProjectDirectoryEntry(child, path))
      folders.push({ name: child.name, path });
  }
  folders.sort((left, right) => left.name.localeCompare(right.name));
  const start = resolveFolderPageStart(
    folders.map((folder) => folder.name),
    input.cursor,
  );
  const entries = folders.slice(start, start + 100);
  const parent = dirname(directory);
  return {
    directory,
    parent: parent === directory ? null : parent,
    entries,
    nextCursor:
      start + entries.length < folders.length ? entries.at(-1)!.name : null,
    roots: availableRoots,
    hostPlatform: process.platform,
  };
}

function isProjectDisplayName(name: string): boolean {
  if (!name) return false;
  if (name.length > 120) return false;
  return !/[\u0000-\u001f]/.test(name);
}

export function projectDisplayName(
  input: string | undefined,
  directory: string,
): string {
  const name = input?.trim() || basename(directory) || directory;
  if (!isProjectDisplayName(name))
    throw new ProjectOperationError(
      "project_name_invalid",
      "Choose a project name of 1 to 120 characters.",
    );
  return name;
}
