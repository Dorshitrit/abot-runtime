import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { assertSafeSnapshotRelativePath } from "./manifest.js";

export type SafeSourceFile = Readonly<{
  relativePath: string;
  bytes: Buffer;
}>;

const GENERATED_TOP_LEVEL_DIRECTORIES = new Set([
  ".git",
  ".runtime",
  "coverage",
  "dist",
  "node_modules",
]);

function isInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

async function assertPhysicalDirectory(
  path: string,
  label: string,
): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a physical directory: ${path}`);
  }
  if ((await realpath(path)) !== resolve(path)) {
    throw new Error(
      `${label} must not traverse symlinked directories: ${path}`,
    );
  }
}

export async function resolveSafeSourceRoot(
  sourceRoot: string,
): Promise<string> {
  const resolved = resolve(sourceRoot);
  await assertPhysicalDirectory(resolved, "source root");
  return resolved;
}

export async function readSafeSourceFile(params: {
  sourceRoot: string;
  relativePath: string;
}): Promise<Readonly<{ bytes: Buffer }>> {
  assertSafeSnapshotRelativePath(params.relativePath);
  const segments = params.relativePath.split("/");
  let current = params.sourceRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(
          `allowed source file is missing: ${params.relativePath}`,
        );
      }
      throw error;
    });
    if (stats.isSymbolicLink()) {
      throw new Error(
        `allowed source path must not contain symlinks: ${params.relativePath}`,
      );
    }
    const final = index === segments.length - 1;
    if (!final && !stats.isDirectory()) {
      throw new Error(
        `source path component is not a directory: ${params.relativePath}`,
      );
    }
    if (final && !stats.isFile()) {
      throw new Error(
        `allowed source path must be a regular file: ${params.relativePath}`,
      );
    }
    if (final) {
      const physicalPath = await realpath(current);
      if (!isInside(params.sourceRoot, physicalPath)) {
        throw new Error(
          `allowed source file escapes source root: ${params.relativePath}`,
        );
      }
      return {
        bytes: await readFile(current),
      };
    }
  }
  throw new Error(`invalid allowed source file: ${params.relativePath}`);
}

export async function expandSafeSourceDirectory(params: {
  explicitPaths: ReadonlySet<string>;
  sourceRoot: string;
  relativePath: string;
  trackedPaths?: ReadonlySet<string>;
}): Promise<readonly SafeSourceFile[]> {
  assertSafeSnapshotRelativePath(params.relativePath);
  const root = resolve(params.sourceRoot, ...params.relativePath.split("/"));
  let current = params.sourceRoot;
  for (const segment of params.relativePath.split("/")) {
    current = resolve(current, segment);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(
          `allowed source directory is missing: ${params.relativePath}`,
        );
      }
      throw error;
    });
    if (stats.isSymbolicLink()) {
      throw new Error(
        `allowed source directory must not contain symlinks: ${params.relativePath}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `allowed source directory is not a directory: ${params.relativePath}`,
      );
    }
  }
  if (!isInside(params.sourceRoot, await realpath(root))) {
    throw new Error(
      `allowed source directory escapes source root: ${params.relativePath}`,
    );
  }

  const files: SafeSourceFile[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = `${prefix}/${entry.name}`;
      const absolutePath = resolve(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `allowed source directory contains a symlink: ${relativePath}`,
        );
      }
      if (stats.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(
          `allowed source directory contains a special file: ${relativePath}`,
        );
      }
      if (params.explicitPaths.has(relativePath)) {
        continue;
      }
      if (
        params.trackedPaths !== undefined &&
        !params.trackedPaths.has(relativePath)
      ) {
        throw new Error(
          `selected public directory contains an untracked file: ${relativePath}`,
        );
      }
      const physicalPath = await realpath(absolutePath);
      if (!isInside(params.sourceRoot, physicalPath)) {
        throw new Error(
          `allowed source file escapes source root: ${relativePath}`,
        );
      }
      files.push({
        relativePath,
        bytes: await readFile(absolutePath),
      });
    }
  }
  await walk(root, params.relativePath);
  return Object.freeze(files);
}

export async function prepareEmptyOutputDirectory(params: {
  sourceRoot: string;
  outputRoot: string;
}): Promise<string> {
  const outputRoot = resolve(params.outputRoot);
  if (isInside(params.sourceRoot, outputRoot)) {
    throw new Error("public snapshot output must be outside the source root");
  }
  const parent = dirname(outputRoot);
  await assertPhysicalDirectory(parent, "output parent");
  const physicalOutput = resolve(await realpath(parent), basename(outputRoot));
  if (isInside(params.sourceRoot, physicalOutput)) {
    throw new Error("public snapshot output resolves inside the source root");
  }

  try {
    const stats = await lstat(outputRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `snapshot output must be a physical directory: ${outputRoot}`,
      );
    }
    if ((await readdir(outputRoot)).length !== 0) {
      throw new Error(`snapshot output directory must be empty: ${outputRoot}`);
    }
    if ((await realpath(outputRoot)) !== physicalOutput) {
      throw new Error(
        `snapshot output must not traverse symlinked directories: ${outputRoot}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(outputRoot, { recursive: false });
  }
  return outputRoot;
}

export async function writeNewSnapshotFile(params: {
  outputRoot: string;
  relativePath: string;
  bytes: Buffer | string;
}): Promise<void> {
  const target = resolve(params.outputRoot, ...params.relativePath.split("/"));
  if (!isInside(params.outputRoot, target)) {
    throw new Error(
      `snapshot target escapes output root: ${params.relativePath}`,
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, params.bytes, {
    flag: "wx",
    mode: 0o644,
  });
  await chmod(target, 0o644);
}

export async function listPhysicalSnapshotFiles(
  outputRoot: string,
  options: Readonly<{ ignoreGeneratedDirectories?: boolean }> = {},
): Promise<readonly string[]> {
  const files: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`snapshot contains a symlink: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        if (
          prefix === "" &&
          options.ignoreGeneratedDirectories === true &&
          GENERATED_TOP_LEVEL_DIRECTORIES.has(entry.name)
        ) {
          continue;
        }
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`snapshot contains a special file: ${relativePath}`);
      }
      files.push(relativePath);
    }
  }
  await assertPhysicalDirectory(outputRoot, "snapshot root");
  await walk(outputRoot, "");
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.freeze(files);
}
