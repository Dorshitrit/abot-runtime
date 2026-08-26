import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PUBLIC_PLUGIN_IDS,
  PUBLIC_ROOT_OVERLAYS,
  PUBLIC_SNAPSHOT_FILE_NAME,
  PUBLIC_SNAPSHOT_SCHEMA_VERSION,
  type PublicPluginId,
  type PublicSnapshotFileRecord,
  type PublicSnapshotManifest,
  type PublicSnapshotRecord,
} from "./contracts.js";
import {
  loadBuildOnlyDenylistTerms,
  scanPublicTextFiles,
} from "./content-scan.js";
import {
  expandSafeSourceDirectory,
  listPhysicalSnapshotFiles,
  prepareEmptyOutputDirectory,
  readSafeSourceFile,
  resolveSafeSourceRoot,
  writeNewSnapshotFile,
} from "./filesystem.js";
import {
  assertCleanGitWorktree,
  assertExactGitRoot,
  listTrackedSnapshotFiles,
} from "./git-tracked.js";
import {
  assertNoSnapshotPathCollisions,
  assertSafeSnapshotRelativePath,
  canonicalSnapshotPathKey,
  decodePublicSnapshotManifest,
  isSnapshotPathSelected,
} from "./manifest.js";
import {
  assertPrivateSourcePackageLock,
  assertPrivateSourcePackageJson,
  transformPublicPackageLock,
  transformPublicPackageJson,
} from "./package-transform.js";
import { stableStringify } from "./stable-json.js";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestHash(manifest: PublicSnapshotManifest): string {
  return sha256(stableStringify(manifest));
}

function decodeSnapshotRecord(value: unknown): PublicSnapshotRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} must contain an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PUBLIC_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} has an unsupported schema`);
  }
  if (
    typeof record.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.manifestSha256)
  ) {
    throw new Error(
      `${PUBLIC_SNAPSHOT_FILE_NAME} has an invalid manifest hash`,
    );
  }
  if (
    typeof record.treeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.treeSha256)
  ) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} has an invalid tree hash`);
  }
  if (!Array.isArray(record.plugins) || !Array.isArray(record.files)) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} has invalid arrays`);
  }
  const plugins = record.plugins as unknown[];
  if (
    plugins.length !== PUBLIC_PLUGIN_IDS.length ||
    plugins.some((plugin, index) => plugin !== PUBLIC_PLUGIN_IDS[index])
  ) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} has the wrong plugin set`);
  }
  const files = record.files.map((entry, index): PublicSnapshotFileRecord => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `${PUBLIC_SNAPSHOT_FILE_NAME}.files[${index}] is invalid`,
      );
    }
    const file = entry as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error(
        `${PUBLIC_SNAPSHOT_FILE_NAME}.files[${index}] is invalid`,
      );
    }
    assertSafeSnapshotRelativePath(file.path);
    return Object.freeze({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    });
  });
  assertNoSnapshotPathCollisions(files.map((file) => file.path));
  const sortedPaths = files.map((file) => file.path).sort(compareText);
  if (files.some((file, index) => file.path !== sortedPaths[index])) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} inventory must be sorted`);
  }
  return Object.freeze({
    schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    manifestSha256: record.manifestSha256,
    plugins: Object.freeze([...PUBLIC_PLUGIN_IDS]) as readonly PublicPluginId[],
    treeSha256: record.treeSha256,
    files: Object.freeze(files),
  });
}

async function verifyPublicPlugins(params: {
  outputRoot: string;
  fileSet: ReadonlySet<string>;
}): Promise<void> {
  for (const pluginId of PUBLIC_PLUGIN_IDS) {
    const pluginManifestPath = `plugins/${pluginId}/plugin.json`;
    const manifest = JSON.parse(
      await readFile(resolve(params.outputRoot, pluginManifestPath), "utf-8"),
    ) as Record<string, unknown>;
    if (manifest.name !== pluginId) {
      throw new Error(`${pluginManifestPath} must declare name=${pluginId}`);
    }
    const extensions = manifest.extensions as
      | Record<string, unknown>
      | undefined;
    const runtime = extensions?.["ai.abot.runtime"] as
      | Record<string, unknown>
      | undefined;
    const entrypoint = runtime?.entrypoint;
    if (typeof entrypoint !== "string" || !entrypoint.startsWith("./")) {
      throw new Error(
        `${pluginManifestPath} has an invalid runtime entrypoint`,
      );
    }
    const entrypointPath = `plugins/${pluginId}/${entrypoint.slice(2)}`;
    if (!params.fileSet.has(entrypointPath)) {
      throw new Error(
        `${pluginManifestPath} entrypoint is absent: ${entrypointPath}`,
      );
    }
    const capabilities = runtime?.capabilities;
    if (
      typeof capabilities !== "object" ||
      capabilities === null ||
      Array.isArray(capabilities)
    ) {
      throw new Error(`${pluginManifestPath} has invalid capabilities`);
    }
    const skills = new Set<string>();
    for (const capability of Object.values(
      capabilities as Record<string, unknown>,
    )) {
      if (
        typeof capability !== "object" ||
        capability === null ||
        Array.isArray(capability)
      ) {
        throw new Error(`${pluginManifestPath} has an invalid capability`);
      }
      const declaredSkills = (capability as Record<string, unknown>).skills;
      if (declaredSkills === undefined) continue;
      if (
        !Array.isArray(declaredSkills) ||
        declaredSkills.some((skill) => typeof skill !== "string")
      ) {
        throw new Error(`${pluginManifestPath} has invalid skill references`);
      }
      for (const skill of declaredSkills as string[]) skills.add(skill);
    }
    for (const skill of skills) {
      const skillPath = `plugins/${pluginId}/skills/${skill}/SKILL.md`;
      if (!params.fileSet.has(skillPath)) {
        throw new Error(`${pluginManifestPath} skill is absent: ${skillPath}`);
      }
    }
  }
}

export async function buildPublicSnapshot(params: {
  sourceRoot: string;
  outputRoot: string;
}): Promise<PublicSnapshotRecord> {
  const sourceRoot = await resolveSafeSourceRoot(params.sourceRoot);
  await assertExactGitRoot(sourceRoot);
  await assertCleanGitWorktree(sourceRoot);
  const embeddedManifest = await readSafeSourceFile({
    sourceRoot,
    relativePath: "public-snapshot.manifest.json",
  });
  const manifest = decodePublicSnapshotManifest(
    JSON.parse(embeddedManifest.bytes.toString("utf-8")) as unknown,
  );
  const trackedPaths = await listTrackedSnapshotFiles({
    sourceRoot,
    directories: manifest.directories,
    files: manifest.files,
  });
  for (const relativePath of manifest.files) {
    if (!trackedPaths.has(relativePath)) {
      throw new Error(
        `public snapshot manifest file must be Git-tracked: ${relativePath}`,
      );
    }
  }
  const sourcePackageFile = await readSafeSourceFile({
    sourceRoot,
    relativePath: "package.json",
  });
  const sourcePackageJson = JSON.parse(
    sourcePackageFile.bytes.toString("utf-8"),
  ) as unknown;
  assertPrivateSourcePackageJson(sourcePackageJson);
  const publicPackageJson = transformPublicPackageJson(sourcePackageJson);
  const explicitPaths = new Set(manifest.files);
  const explicitFiles = await Promise.all(
    manifest.files.map(async (relativePath) => {
      if (Object.hasOwn(PUBLIC_ROOT_OVERLAYS, relativePath)) {
        return {
          relativePath,
          bytes: Buffer.from(
            PUBLIC_ROOT_OVERLAYS[
              relativePath as keyof typeof PUBLIC_ROOT_OVERLAYS
            ],
            "utf-8",
          ),
        };
      }
      const source = await readSafeSourceFile({ sourceRoot, relativePath });
      if (relativePath === "package.json") {
        return {
          relativePath,
          bytes: Buffer.from(
            `${stableStringify(publicPackageJson)}\n`,
            "utf-8",
          ),
        };
      }
      if (relativePath === "package-lock.json") {
        const sourcePackageLock = JSON.parse(
          source.bytes.toString("utf-8"),
        ) as unknown;
        assertPrivateSourcePackageLock(sourcePackageLock, sourcePackageJson);
        const publicPackageLock = transformPublicPackageLock(
          sourcePackageLock,
          publicPackageJson,
        );
        return {
          relativePath,
          bytes: Buffer.from(
            `${stableStringify(publicPackageLock)}\n`,
            "utf-8",
          ),
        };
      }
      return { relativePath, bytes: source.bytes };
    }),
  );
  const directoryFiles = (
    await Promise.all(
      manifest.directories.map((relativePath) =>
        expandSafeSourceDirectory({
          explicitPaths,
          sourceRoot,
          relativePath,
          trackedPaths,
        }),
      ),
    )
  ).flat();
  const prepared = [...explicitFiles, ...directoryFiles].sort((left, right) =>
    compareText(left.relativePath, right.relativePath),
  );
  assertNoSnapshotPathCollisions(prepared.map((file) => file.relativePath));
  scanPublicTextFiles(prepared, await loadBuildOnlyDenylistTerms(sourceRoot));
  const outputRoot = await prepareEmptyOutputDirectory({
    sourceRoot,
    outputRoot: params.outputRoot,
  });
  const files: PublicSnapshotFileRecord[] = [];
  for (const file of prepared) {
    await writeNewSnapshotFile({
      outputRoot,
      relativePath: file.relativePath,
      bytes: file.bytes,
    });
    files.push(
      Object.freeze({
        path: file.relativePath,
        sha256: sha256(file.bytes),
        size: file.bytes.byteLength,
      }),
    );
  }
  files.sort((left, right) => compareText(left.path, right.path));
  const record: PublicSnapshotRecord = Object.freeze({
    schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    manifestSha256: manifestHash(manifest),
    plugins: Object.freeze([...PUBLIC_PLUGIN_IDS]),
    treeSha256: sha256(stableStringify(files)),
    files: Object.freeze(files),
  });
  await writeNewSnapshotFile({
    outputRoot,
    relativePath: PUBLIC_SNAPSHOT_FILE_NAME,
    bytes: `${stableStringify(record)}\n`,
  });
  await verifyPublicSnapshot({ outputRoot });
  return record;
}

export async function verifyPublicSnapshot(params: {
  outputRoot: string;
}): Promise<PublicSnapshotRecord> {
  const outputRoot = resolve(params.outputRoot);
  const paths = await listPhysicalSnapshotFiles(outputRoot, {
    ignoreGeneratedDirectories: true,
  });
  const collisionKeys = new Map<string, string>();
  for (const path of paths) {
    const key = canonicalSnapshotPathKey(path);
    const previous = collisionKeys.get(key);
    if (previous && previous !== path) {
      throw new Error(
        `snapshot contains a case or Unicode collision: ${previous} <> ${path}`,
      );
    }
    collisionKeys.set(key, path);
  }
  if (!paths.includes(PUBLIC_SNAPSHOT_FILE_NAME)) {
    throw new Error(`snapshot is missing ${PUBLIC_SNAPSHOT_FILE_NAME}`);
  }
  if (!paths.includes("public-snapshot.manifest.json")) {
    throw new Error("snapshot is missing its embedded public manifest");
  }
  const manifest = decodePublicSnapshotManifest(
    JSON.parse(
      await readFile(
        resolve(outputRoot, "public-snapshot.manifest.json"),
        "utf-8",
      ),
    ) as unknown,
  );
  const metadataText = await readFile(
    resolve(outputRoot, PUBLIC_SNAPSHOT_FILE_NAME),
    "utf-8",
  );
  const record = decodeSnapshotRecord(JSON.parse(metadataText) as unknown);
  if (`${stableStringify(record)}\n` !== metadataText) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} is not canonical`);
  }
  if (record.manifestSha256 !== manifestHash(manifest)) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} does not match the manifest`);
  }
  if (record.treeSha256 !== sha256(stableStringify(record.files))) {
    throw new Error(`${PUBLIC_SNAPSHOT_FILE_NAME} has an invalid tree hash`);
  }
  for (const file of record.files) {
    if (!isSnapshotPathSelected(file.path, manifest)) {
      throw new Error(
        `${PUBLIC_SNAPSHOT_FILE_NAME} contains a path outside the positive allowlist: ${file.path}`,
      );
    }
  }
  for (const requiredPath of manifest.files) {
    if (!record.files.some((file) => file.path === requiredPath)) {
      throw new Error(
        `${PUBLIC_SNAPSHOT_FILE_NAME} is missing exact file: ${requiredPath}`,
      );
    }
  }
  for (const directory of manifest.directories) {
    if (!record.files.some((file) => file.path.startsWith(`${directory}/`))) {
      throw new Error(
        `${PUBLIC_SNAPSHOT_FILE_NAME} has an empty directory: ${directory}`,
      );
    }
  }
  const actualPayloadPaths = paths.filter(
    (path) => path !== PUBLIC_SNAPSHOT_FILE_NAME,
  );
  if (
    actualPayloadPaths.length !== record.files.length ||
    actualPayloadPaths.some((path, index) => path !== record.files[index]?.path)
  ) {
    throw new Error(
      "snapshot payload files do not match the positive allowlist",
    );
  }
  const scannedFiles: Array<{ relativePath: string; bytes: Buffer }> = [];
  for (const expected of record.files) {
    const path = resolve(outputRoot, ...expected.path.split("/"));
    const bytes = await readFile(path);
    if (
      bytes.byteLength !== expected.size ||
      sha256(bytes) !== expected.sha256
    ) {
      throw new Error(
        `snapshot file failed integrity verification: ${expected.path}`,
      );
    }
    scannedFiles.push({ relativePath: expected.path, bytes });
  }
  scanPublicTextFiles(scannedFiles);
  const packageText = await readFile(
    resolve(outputRoot, "package.json"),
    "utf-8",
  );
  const parsedPackage = JSON.parse(packageText) as unknown;
  const transformedPackage = transformPublicPackageJson(parsedPackage);
  if (`${stableStringify(transformedPackage)}\n` !== packageText) {
    throw new Error(
      "snapshot package.json is not the canonical public transform",
    );
  }
  const packageLockText = await readFile(
    resolve(outputRoot, "package-lock.json"),
    "utf-8",
  );
  const transformedPackageLock = transformPublicPackageLock(
    JSON.parse(packageLockText) as unknown,
    parsedPackage,
  );
  if (`${stableStringify(transformedPackageLock)}\n` !== packageLockText) {
    throw new Error(
      "snapshot package-lock.json is not the canonical public transform",
    );
  }
  await verifyPublicPlugins({
    outputRoot,
    fileSet: new Set(record.files.map((file) => file.path)),
  });
  return record;
}
