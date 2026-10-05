import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { RuntimePaths } from "../ports.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import type { FolderSource } from "./definition-contracts.js";

const MAX_SOURCE_ENTRIES = 1_000;
const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;
const MIN_STABLE_AGE_MS = 1_000;

const SUPPORTED_MIME = new Map<string, Readonly<{ kind: "image" | "file"; mimeType: string }>>([
  [".png", { kind: "image", mimeType: "image/png" }],
  [".jpg", { kind: "image", mimeType: "image/jpeg" }],
  [".jpeg", { kind: "image", mimeType: "image/jpeg" }],
  [".webp", { kind: "image", mimeType: "image/webp" }],
  [".pdf", { kind: "file", mimeType: "application/pdf" }],
  [".docx", { kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
  [".xlsx", { kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  [".pptx", { kind: "file", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
  [".txt", { kind: "file", mimeType: "text/plain" }],
  [".csv", { kind: "file", mimeType: "text/csv" }],
  [".md", { kind: "file", mimeType: "text/markdown" }],
  [".json", { kind: "file", mimeType: "application/json" }],
  [".rtf", { kind: "file", mimeType: "application/rtf" }],
]);

export type DiscoveredSourceFile = Readonly<{
  canonicalPath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  kind: "image" | "file";
  mimeType: string;
}>;

export type CapturedSourceFile = DiscoveredSourceFile & Readonly<{
  bytes: Uint8Array;
  contentVersion: string;
}>;

function within(path: string, root: string): boolean {
  const scoped = relative(root, path);
  return scoped === "" || (scoped !== ".." && !scoped.startsWith(`..${sep}`));
}

function glob(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else expression += "[^/]*";
      continue;
    }
    if (char === "?") { expression += "[^/]"; continue; }
    expression += /[\\^$+?.()|{}\[\]]/u.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${expression}$`, "u");
}

function matches(relativePath: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) =>
    pattern.test(relativePath) || pattern.test(basename(relativePath)));
}

export async function discoverSourceFiles(input: {
  source: FolderSource;
  paths: RuntimePaths;
  now?: number;
}): Promise<{ root: string; files: DiscoveredSourceFile[]; unstableCount: number }> {
  const resolver = createRuntimeToolPathResolver(input.paths);
  const resolved = resolver.resolve(input.source.location.path, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace", "host_system"],
  });
  const root = await realpath(resolved.absolutePath);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error("automation_source_unavailable");
  const excludedRoots = [input.paths.attachmentsDir,
    join(input.paths.runtimeDir, "automation-results")].map((path) => resolve(path));
  if (excludedRoots.some((excluded) => within(root, excluded)))
    throw new Error("automation_source_unavailable");
  const includes = input.source.includePatterns.map(glob);
  const excludes = input.source.excludePatterns.map(glob);
  const now = input.now ?? Date.now();
  const files: DiscoveredSourceFile[] = [];
  let unstableCount = 0;
  const directories = [root];
  let visited = 0;
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_SOURCE_ENTRIES)
        throw new Error("automation_source_capacity_exceeded");
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const canonical = await realpath(candidate).catch(() => null);
      if (!canonical || !within(canonical, root)) continue;
      if (excludedRoots.some((excluded) => within(canonical, excluded))) continue;
      const relativePath = relative(root, canonical).replaceAll(sep, "/");
      if (matches(relativePath, excludes) ||
          (entry.isDirectory() && matches(`${relativePath}/`, excludes))) continue;
      if (entry.isDirectory()) {
        if (input.source.recursive) directories.push(canonical);
        continue;
      }
      if (!entry.isFile()) continue;
      if (includes.length > 0 && !matches(relativePath, includes)) continue;
      const metadata = await lstat(canonical);
      if (!metadata.isFile()) continue;
      if (now - metadata.mtimeMs < MIN_STABLE_AGE_MS) {
        unstableCount += 1;
        continue;
      }
      const supported = SUPPORTED_MIME.get(extname(canonical).toLowerCase());
      if (!supported || metadata.size > MAX_SOURCE_FILE_BYTES)
        throw new Error("automation_source_unavailable");
      files.push({
        canonicalPath: canonical,
        relativePath,
        sizeBytes: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        ...supported,
      });
    }
  }
  files.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  return { root, files, unstableCount };
}

export async function captureSourceFile(
  file: DiscoveredSourceFile,
): Promise<CapturedSourceFile> {
  try {
    return await readStableSourceFile(file);
  } catch (error) {
    if (error instanceof Error && "code" in error &&
        ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code)))
      throw new Error("automation_source_changed", { cause: error });
    throw error;
  }
}

async function readStableSourceFile(
  file: DiscoveredSourceFile,
): Promise<CapturedSourceFile> {
  if (await realpath(file.canonicalPath) !== file.canonicalPath)
    throw new Error("automation_source_changed");
  const handle = await open(file.canonicalPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_SOURCE_FILE_BYTES ||
        before.size !== file.sizeBytes || before.mtimeMs !== file.mtimeMs ||
        before.ctimeMs !== file.ctimeMs)
      throw new Error("automation_source_changed");
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(file.canonicalPath);
    const canonicalAfter = await realpath(file.canonicalPath);
    if (offset !== before.size || after.size !== before.size ||
        canonicalAfter !== file.canonicalPath ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        pathAfter.ino !== before.ino || pathAfter.dev !== before.dev ||
        pathAfter.size !== before.size ||
        pathAfter.mtimeMs !== before.mtimeMs ||
        pathAfter.ctimeMs !== before.ctimeMs)
      throw new Error("automation_source_changed");
    const bytes = buffer.subarray(0, offset);
    return {
      ...file,
      bytes,
      contentVersion: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}
