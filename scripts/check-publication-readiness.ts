import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertExactPublicPluginPackagePaths,
  decodePublicSnapshotManifest,
} from "./public-snapshot/index.js";
import { scanPublicTextFiles } from "./public-snapshot/content-scan.js";
import {
  expandSafeSourceDirectory,
  readSafeSourceFile,
  resolveSafeSourceRoot,
} from "./public-snapshot/filesystem.js";

type PackageJson = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  license?: unknown;
  private?: unknown;
  keywords?: unknown;
  engines?: {
    node?: unknown;
  };
  exports?: unknown;
  files?: unknown;
  scripts?: Record<string, unknown>;
};

const rootDir = process.cwd();
const LOCAL_PUBLICATION_DENYLIST_FILE = ".publication-denylist.local";
const ignoredDirectoryNames = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const ignoredRootDirectories = new Set([
  ".runtime",
  "logs",
  "local",
  "sandbox",
  "sessions",
  "memory",
]);
const allowedRootMarkdown = new Set([
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
]);

function fail(message: string): never {
  throw new Error(message);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function assertString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function assertPackageMetadata(pkg: PackageJson): boolean {
  assertString(pkg.name, "package.name");
  assertString(pkg.version, "package.version");
  assertString(pkg.description, "package.description");
  assertString(pkg.license, "package.license");
  assertString(pkg.engines?.node, "package.engines.node");

  if (pkg.private !== true && pkg.private !== false) {
    fail("package.private must explicitly declare true or false");
  }
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) {
    fail("package.keywords must contain at least one keyword");
  }
  if (!pkg.exports || typeof pkg.exports !== "object") {
    fail("package.exports must define the public package surface");
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail("package.files must define the published package contents");
  }

  const scripts = pkg.scripts ?? {};
  for (const scriptName of [
    "init",
    "build",
    "test",
    "check:runtime-package",
    "check:publication",
    "validate",
  ]) {
    assertString(scripts[scriptName], `package.scripts.${scriptName}`);
  }
  return pkg.private === false;
}

function assertRequiredFiles(): void {
  const requiredFiles = [
    ".env.example",
    ".gitignore",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "docs/architecture.md",
    "docs/configuration.md",
    "docs/installation.md",
    "docs/bridge-compatibility.md",
    "docs/known-limitations.md",
    "docs/plugins.md",
    "docs/publishing.md",
    "docs/running-locally.md",
    "docs/tool-execution-result-evidence-contract.md",
    "docs/troubleshooting.md",
    "examples/minimal-runtime-composition.ts",
    "examples/request-runner.config.example.json",
    "examples/runtime.config.example.json",
    "scripts/init-runtime.ts",
  ];

  for (const relativePath of requiredFiles) {
    try {
      const stats = statSync(join(rootDir, relativePath));
      if (!stats.isFile()) {
        fail(`required publication file is not a file: ${relativePath}`);
      }
    } catch {
      fail(`required publication file is missing: ${relativePath}`);
    }
  }
}

function assertPublicationFileLayout(paths: readonly string[]): void {
  const forbiddenTrackedPatterns = [
    /^\.codex($|\/)/,
    /^\.env$/,
    /^\.env\.(?!example$)/,
    /^runtime\.config\.json$/,
    /^runtime\.config\.local\.json$/,
    /^\.publication-denylist\.local$/,
    /^\.runtime\//,
    /^logs\//,
    /^sandbox\//,
    /^sessions\//,
    /^memory\//,
    /^dist\//,
    /\.bak$/,
    /(^|\/)[^/]*:Zone\.Identifier$/,
  ];

  for (const inspectedPath of paths) {
    if (!existsSync(join(rootDir, inspectedPath))) {
      continue;
    }
    if (
      /^[^/]+\.md$/.test(inspectedPath) &&
      !allowedRootMarkdown.has(inspectedPath)
    ) {
      fail(
        `root markdown should be moved under docs or removed: ${inspectedPath}`,
      );
    }
    const forbidden = forbiddenTrackedPatterns.find((pattern) =>
      pattern.test(inspectedPath),
    );
    if (forbidden) {
      fail(`publication-forbidden file: ${inspectedPath}`);
    }
  }
}

function listPhysicalFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (ignoredDirectoryNames.has(entry.name) ||
        (prefix === "" && ignoredRootDirectories.has(entry.name)))
    ) {
      continue;
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    const stats = lstatSync(fullPath);
    if (stats.isSymbolicLink()) {
      fail(`publication source contains a symlink: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      files.push(...listPhysicalFiles(fullPath, relativePath));
      continue;
    }
    if (stats.isFile()) {
      files.push(relativePath);
      continue;
    }
    fail(`publication source contains a special file: ${relativePath}`);
  }
  return files.sort();
}

async function listSelectedPrivateSourceFiles(): Promise<readonly string[]> {
  const manifest = decodePublicSnapshotManifest(
    readJson<unknown>(join(rootDir, "public-snapshot.manifest.json")),
  );
  const sourceRoot = await resolveSafeSourceRoot(rootDir);
  const explicitPaths = new Set(manifest.files);
  await Promise.all(
    manifest.files.map((relativePath) =>
      readSafeSourceFile({ sourceRoot, relativePath }),
    ),
  );
  const directoryFiles = (
    await Promise.all(
      manifest.directories.map((relativePath) =>
        expandSafeSourceDirectory({
          explicitPaths,
          sourceRoot,
          relativePath,
        }),
      ),
    )
  ).flat();
  return Object.freeze(
    [
      ...manifest.files,
      ...directoryFiles.map(({ relativePath }) => relativePath),
    ]
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort(),
  );
}

function readLocalPrivateTerms(): string[] {
  const terms: string[] = [];
  const envValue = process.env.LLM_RUNTIME_PUBLICATION_FORBIDDEN_TERMS ?? "";
  terms.push(...envValue.split(/[\n,]/));

  const localDenylistPath = join(rootDir, LOCAL_PUBLICATION_DENYLIST_FILE);
  if (existsSync(localDenylistPath)) {
    terms.push(...readFileSync(localDenylistPath, "utf-8").split(/\r?\n/));
  }

  return [
    ...new Set(
      terms
        .map((term) => term.trim())
        .filter((term) => term.length > 0 && !term.startsWith("#")),
    ),
  ];
}

function assertNoPrivateResidue(paths: readonly string[]): void {
  scanPublicTextFiles(
    paths.map((relativePath) => ({
      relativePath,
      bytes: Buffer.from(readFileSync(join(rootDir, relativePath))),
    })),
    readLocalPrivateTerms(),
  );
}

function assertEnvExampleDoesNotPinRuntimeEnvironment(): void {
  const raw = readFileSync(join(rootDir, ".env.example"), "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (
      trimmed.startsWith("LLM_RUNTIME_WEB_ENVIRONMENT=") &&
      trimmed !== "LLM_RUNTIME_WEB_ENVIRONMENT="
    ) {
      fail(
        ".env.example must not pin LLM_RUNTIME_WEB_ENVIRONMENT; web UI defaults should come from runtime config",
      );
    }
  }
}

function assertRootMarkdownLayout(): void {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith(".md") && !allowedRootMarkdown.has(entry.name)) {
      fail(
        `root markdown should be moved under docs or removed: ${entry.name}`,
      );
    }
  }
}

function assertNoWindowsBackupArtifacts(dir: string, prefix = ""): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (ignoredDirectoryNames.has(entry.name) ||
        (prefix === "" && ignoredRootDirectories.has(entry.name)))
    ) {
      continue;
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);

    if (
      entry.name.endsWith(".bak") ||
      entry.name.endsWith(":Zone.Identifier")
    ) {
      fail(`publication-forbidden local artifact: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      assertNoWindowsBackupArtifacts(fullPath, relativePath);
    }
  }
}

function assertNoDevelopmentPlanDocs(): void {
  const docsDir = join(rootDir, "docs");

  function walk(dir: string, prefix = "docs"): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = `${prefix}/${entry.name}`;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "todo") {
          fail(
            `development planning docs do not belong in public docs: ${relativePath}`,
          );
        }
        walk(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      if (/(^|[-_])(plan|workplan|review)([-_]|\.md$)/.test(entry.name)) {
        fail(
          `development planning docs do not belong in public docs: ${relativePath}`,
        );
      }
    }
  }

  walk(docsDir);
}

function assertExampleConfigIsSanitized(): void {
  const config = readJson<Record<string, unknown>>(
    join(rootDir, "examples/runtime.config.example.json"),
  );
  if ("agentId" in config) {
    fail("examples/runtime.config.example.json must not contain agentId");
  }
  const raw = JSON.stringify(config);
  for (const forbidden of ["OPENAI_API_KEY=", "AGENT_BRIDGE_TOKEN="]) {
    if (raw.includes(forbidden)) {
      fail(
        `example config appears to contain a secret assignment: ${forbidden}`,
      );
    }
  }
}

const pkg = readJson<PackageJson>(join(rootDir, "package.json"));
const isPublicRelease = assertPackageMetadata(pkg);
const publicationFiles = isPublicRelease
  ? listPhysicalFiles(rootDir)
  : await listSelectedPrivateSourceFiles();

assertRequiredFiles();
assertRootMarkdownLayout();
assertPublicationFileLayout(publicationFiles);
assertNoPrivateResidue(publicationFiles);
assertEnvExampleDoesNotPinRuntimeEnvironment();
assertNoWindowsBackupArtifacts(rootDir);
assertNoDevelopmentPlanDocs();
assertExampleConfigIsSanitized();
if (isPublicRelease) {
  assertExactPublicPluginPackagePaths(publicationFiles);
}

console.log("publication readiness ok");
