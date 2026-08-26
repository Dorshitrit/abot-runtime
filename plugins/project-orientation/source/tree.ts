import { opendir, stat } from "node:fs/promises";
import { posix } from "node:path";

import type {
  ResolvedRuntimeToolPath,
  RuntimePluginLoadContext,
} from "../../../src/plugin-sdk/index.js";
import { resolvePluginPath } from "../../../src/plugin-sdk/index.js";
import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

const IGNORED_NAMES = new Set([".git", "node_modules", "dist", "coverage"]);
const DISPLAY_PATH_MAX_CHARS = 64;

export type ProjectTree = Readonly<{
  directories: readonly string[];
  files: readonly string[];
  entries: number;
  truncated: boolean;
  truncatedPathCount: number;
  sampling: "bounded_directory_iteration";
}>;

function childLogicalPath(
  parent: ResolvedRuntimeToolPath,
  childName: string,
): string {
  if (parent.logicalPath === ".") return childName;
  return posix.join(parent.logicalPath, childName);
}

function relativeDisplayPath(
  root: ResolvedRuntimeToolPath,
  child: ResolvedRuntimeToolPath,
): string {
  if (child.logicalPath === root.logicalPath) return ".";
  if (root.logicalPath === ".") return child.logicalPath;
  const prefix = `${root.logicalPath}/`;
  return child.logicalPath.startsWith(prefix)
    ? child.logicalPath.slice(prefix.length)
    : child.logicalPath;
}

function boundedDisplayPath(path: string): Readonly<{
  path: string;
  truncated: boolean;
}> {
  const characters = [...sanitizeJsonText(path)];
  if (characters.length <= DISPLAY_PATH_MAX_CHARS) {
    return Object.freeze({ path, truncated: false });
  }
  const separator = "…";
  const sideChars = Math.floor((DISPLAY_PATH_MAX_CHARS - separator.length) / 2);
  return Object.freeze({
    path: `${characters.slice(0, sideChars).join("")}${separator}${characters.slice(-sideChars).join("")}`,
    truncated: true,
  });
}

export async function collectProjectTree(
  context: RuntimePluginLoadContext,
  root: ResolvedRuntimeToolPath,
  depth: number,
  maxEntries: number,
): Promise<ProjectTree> {
  const directories: string[] = [];
  const files: string[] = [];
  let entries = 0;
  let truncated = false;
  let truncatedPathCount = 0;
  const queue: Readonly<{
    target: ResolvedRuntimeToolPath;
    remainingDepth: number;
  }>[] = [{ target: root, remainingDepth: depth }];

  while (queue.length > 0 && entries < maxEntries) {
    const current = queue.shift();
    if (!current) break;
    const sampled: Readonly<{ name: string; isDirectory: boolean }>[] = [];
    const directory = await opendir(current.target.absolutePath);
    for await (const entry of directory) {
      if (entry.isDirectory() && IGNORED_NAMES.has(entry.name)) continue;
      if (entries + sampled.length >= maxEntries) {
        truncated = true;
        break;
      }
      sampled.push({ name: entry.name, isDirectory: entry.isDirectory() });
    }
    sampled.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sampled) {
      const child = resolvePluginPath(
        context,
        childLogicalPath(current.target, entry.name),
        {
          requirePath: true,
          allowedLocations: ["agent_work", "workspace"],
        },
      );
      const info = await stat(child.absolutePath);
      const display = boundedDisplayPath(relativeDisplayPath(root, child));
      if (display.truncated) truncatedPathCount += 1;
      entries += 1;
      if (info.isDirectory()) {
        directories.push(display.path);
        if (current.remainingDepth > 0) {
          queue.push({
            target: child,
            remainingDepth: current.remainingDepth - 1,
          });
        }
      } else if (info.isFile()) {
        files.push(display.path);
      }
    }
  }
  if (queue.length > 0) truncated = true;
  directories.sort((left, right) => left.localeCompare(right));
  files.sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    directories: Object.freeze(directories),
    files: Object.freeze(files),
    entries,
    truncated,
    truncatedPathCount,
    sampling: "bounded_directory_iteration" as const,
  });
}
