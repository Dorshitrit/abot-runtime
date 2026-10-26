import { opendir, stat } from "node:fs/promises";
import { posix } from "node:path";

import type {
  ResolvedRuntimeToolPath,
  RuntimePluginLoadContext,
} from "../../../src/plugin-sdk/index.js";
import { resolvePluginPath } from "../../../src/plugin-sdk/index.js";

import {
  ProjectInspectionError,
  throwIfProjectInspectionCancelled,
} from "./inspection-failure.js";

const IGNORED_NAMES = new Set([".git", "node_modules", "dist", "coverage"]);
export const PROJECT_SCAN_ENTRY_LIMIT = 1_000;

export type ProjectTreeEntry = Readonly<{
  path: string;
  kind: "directory" | "file";
}>;

export type ProjectTreeListing = Readonly<{
  entries: readonly ProjectTreeEntry[];
  scannedEntries: number;
}>;

function childLogicalPath(
  parent: ResolvedRuntimeToolPath,
  childName: string,
): string {
  return parent.logicalPath === "."
    ? childName
    : posix.join(parent.logicalPath, childName);
}

function relativeEntryPath(
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

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function collectProjectTree(
  context: RuntimePluginLoadContext,
  root: ResolvedRuntimeToolPath,
  depth: number,
  signal?: AbortSignal,
): Promise<ProjectTreeListing> {
  const entries: ProjectTreeEntry[] = [];
  let scannedEntries = 0;
  const queue: Readonly<{
    target: ResolvedRuntimeToolPath;
    remainingDepth: number;
  }>[] = [{ target: root, remainingDepth: depth }];

  while (queue.length > 0) {
    throwIfProjectInspectionCancelled(signal);
    const current = queue.shift();
    if (!current) break;
    const names: string[] = [];
    const directory = await opendir(current.target.absolutePath);
    for await (const entry of directory) {
      throwIfProjectInspectionCancelled(signal);
      scannedEntries += 1;
      if (scannedEntries > PROJECT_SCAN_ENTRY_LIMIT) {
        throw new ProjectInspectionError(
          "project_scan_limit",
          "Project inspection exceeds the 1000-entry scan limit. Use depth 0 or a narrower project path; no complete listing or continuation was produced.",
        );
      }
      if (entry.isDirectory() && IGNORED_NAMES.has(entry.name)) continue;
      names.push(entry.name);
    }
    names.sort(compareNames);
    for (const name of names) {
      throwIfProjectInspectionCancelled(signal);
      const child = resolvePluginPath(context, childLogicalPath(current.target, name), {
        requirePath: true,
        allowedLocations: ["agent_work", "workspace"],
      });
      const info = await stat(child.absolutePath);
      const path = relativeEntryPath(root, child);
      if (info.isDirectory()) {
        entries.push(Object.freeze({ path, kind: "directory" }));
        if (current.remainingDepth > 0) {
          queue.push({ target: child, remainingDepth: current.remainingDepth - 1 });
        }
      } else if (info.isFile()) {
        entries.push(Object.freeze({ path, kind: "file" }));
      }
    }
  }
  throwIfProjectInspectionCancelled(signal);
  return Object.freeze({ entries: Object.freeze(entries), scannedEntries });
}
