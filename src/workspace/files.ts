import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { WorkspaceSourceFile } from "./types.js";

async function collectMarkdownFiles(
  rootDir: string,
  currentDir: string,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(rootDir, fullPath);
      files.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(relative(rootDir, fullPath).replaceAll("\\", "/"));
    }
  }

  return files;
}

export async function readWorkspaceMarkdownFiles(
  workspaceDir: string,
): Promise<WorkspaceSourceFile[]> {
  await mkdir(workspaceDir, { recursive: true });
  const relPaths = await collectMarkdownFiles(workspaceDir, workspaceDir);
  const files: WorkspaceSourceFile[] = [];
  for (const relPath of relPaths) {
    const content = await readFile(join(workspaceDir, relPath), "utf-8");
    files.push({ path: relPath, content });
  }
  return files;
}

export function buildWorkspaceSourceHash(files: WorkspaceSourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\n");
    hash.update(file.content);
    hash.update("\n---\n");
  }
  return hash.digest("hex");
}

export function buildDeterministicWorkspaceConcat(
  files: WorkspaceSourceFile[],
): string {
  const parts: string[] = [];
  for (const file of files) {
    parts.push(`### FILE: ${file.path}`);
    parts.push(file.content);
    parts.push("");
  }
  return parts.join("\n");
}
