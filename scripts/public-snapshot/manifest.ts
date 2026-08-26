import { posix } from "node:path";

import {
  PUBLIC_PLUGIN_IDS,
  PUBLIC_SNAPSHOT_FILE_NAME,
  PUBLIC_SNAPSHOT_SCHEMA_VERSION,
  REQUIRED_PUBLIC_DIRECTORIES,
  REQUIRED_PUBLIC_SNAPSHOT_FILES,
  type PublicPluginId,
  type PublicSnapshotManifest,
} from "./contracts.js";

const PUBLIC_ROOT_FILES = new Set(
  REQUIRED_PUBLIC_SNAPSHOT_FILES.filter((path) => !path.includes("/")),
);
const PUBLIC_EXACT_NESTED_FILES = new Set([
  ...REQUIRED_PUBLIC_SNAPSHOT_FILES.filter((path) => path.includes("/")),
]);
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

export function canonicalSnapshotPathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function assertSafeSnapshotRelativePath(path: string): void {
  if (path !== path.trim()) {
    throw new Error(
      `snapshot path must not contain surrounding space: ${path}`,
    );
  }
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    posix.isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`snapshot path must be a relative POSIX path: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    posix.normalize(path) !== path
  ) {
    throw new Error(
      `snapshot path contains traversal or empty segments: ${path}`,
    );
  }
  if (path === PUBLIC_SNAPSHOT_FILE_NAME) {
    throw new Error(
      `${PUBLIC_SNAPSHOT_FILE_NAME} is reserved for build output`,
    );
  }
}

export function assertNoSnapshotPathCollisions(paths: readonly string[]): void {
  const seenFiles = new Set<string>();
  const canonicalEntries = new Map<
    string,
    Readonly<{ kind: "directory" | "file"; path: string }>
  >();

  for (const path of paths) {
    if (seenFiles.has(path)) {
      throw new Error(`duplicate snapshot path: ${path}`);
    }
    seenFiles.add(path);
    const segments = path.split("/");
    const entries = segments.map((_, index) => ({
      kind:
        index === segments.length - 1
          ? ("file" as const)
          : ("directory" as const),
      path: segments.slice(0, index + 1).join("/"),
    }));
    for (const entry of entries) {
      const key = canonicalSnapshotPathKey(entry.path);
      const previous = canonicalEntries.get(key);
      if (
        previous &&
        (previous.path !== entry.path || previous.kind !== entry.kind)
      ) {
        throw new Error(
          `case or Unicode snapshot path collision: ${previous.path} <> ${entry.path}`,
        );
      }
      canonicalEntries.set(key, entry);
    }
  }
}

function isAllowedPublicFilePath(path: string): boolean {
  if (PUBLIC_ROOT_FILES.has(path) || PUBLIC_EXACT_NESTED_FILES.has(path)) {
    return true;
  }
  return false;
}

function decodeDirectories(value: unknown): readonly string[] {
  const directories = decodeStringArray(value, "manifest.directories");
  for (const path of directories) {
    assertSafeSnapshotRelativePath(path);
  }
  assertNoSnapshotPathCollisions(directories);
  const sorted = [...directories].sort(compareText);
  for (let index = 0; index < sorted.length; index += 1) {
    const path = sorted[index];
    const nested = sorted.find(
      (candidate, candidateIndex) =>
        candidateIndex !== index && path.startsWith(`${candidate}/`),
    );
    if (nested) {
      throw new Error(`overlapping snapshot directories: ${nested} <> ${path}`);
    }
  }
  const expected = [...REQUIRED_PUBLIC_DIRECTORIES].sort(compareText);
  if (
    sorted.length !== expected.length ||
    sorted.some((path, index) => path !== expected[index])
  ) {
    throw new Error(
      `manifest.directories must contain exactly: ${expected.join(", ")}`,
    );
  }
  return Object.freeze(sorted);
}

function decodePlugins(value: unknown): readonly PublicPluginId[] {
  const plugins = decodeStringArray(value, "manifest.plugins");
  const sorted = [...new Set(plugins)].sort(compareText);
  const expected = [...PUBLIC_PLUGIN_IDS].sort(compareText);
  if (
    plugins.length !== sorted.length ||
    sorted.length !== expected.length ||
    sorted.some((plugin, index) => plugin !== expected[index])
  ) {
    throw new Error(
      `manifest.plugins must contain exactly: ${expected.join(", ")}`,
    );
  }
  return Object.freeze([...PUBLIC_PLUGIN_IDS]);
}

export function decodePublicSnapshotManifest(
  value: unknown,
): PublicSnapshotManifest {
  if (!isPlainRecord(value)) {
    throw new Error("public snapshot manifest must be a plain object");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "directories",
    "files",
    "plugins",
  ]);
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpectedKey) {
    throw new Error(
      `unexpected public snapshot manifest field: ${unexpectedKey}`,
    );
  }
  if (value.schemaVersion !== PUBLIC_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `manifest.schemaVersion must be ${PUBLIC_SNAPSHOT_SCHEMA_VERSION}`,
    );
  }
  const plugins = decodePlugins(value.plugins);
  const directories = decodeDirectories(value.directories);
  const files = decodeStringArray(value.files, "manifest.files");
  for (const path of files) {
    assertSafeSnapshotRelativePath(path);
    if (!isAllowedPublicFilePath(path)) {
      throw new Error(
        `snapshot path is outside the positive allowlist: ${path}`,
      );
    }
  }
  assertNoSnapshotPathCollisions(files);
  const fileSet = new Set(files);
  for (const requiredPath of REQUIRED_PUBLIC_SNAPSHOT_FILES) {
    if (!fileSet.has(requiredPath)) {
      throw new Error(
        `manifest is missing required public file: ${requiredPath}`,
      );
    }
  }

  return Object.freeze({
    schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    directories,
    files: Object.freeze([...files].sort(compareText)),
    plugins,
  });
}

export function isSnapshotPathSelected(
  path: string,
  manifest: PublicSnapshotManifest,
): boolean {
  return (
    manifest.files.includes(path) ||
    manifest.directories.some((directory) => path.startsWith(`${directory}/`))
  );
}
