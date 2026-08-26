import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadRuntimeConfig } from "../src/runtime/config.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_ROOT = resolve(ROOT_DIR, ".runtime");

type CleanupTarget = Readonly<{
  label: string;
  path: string;
}>;

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadRuntimeConfig({ rootDir: ROOT_DIR, profileId: "dev" });
  const targets: readonly CleanupTarget[] = [
    { label: "dev logs", path: dirname(config.paths.traceFile) },
    { label: "shared model logs", path: join(config.paths.sharedDir, "logs") },
    { label: "dev sessions", path: config.paths.sessionsDir },
  ];

  for (const target of targets) {
    assertSafeTarget(target.path);
  }

  for (const target of targets) {
    const count = await cleanDirectory(target.path, dryRun);
    console.log(
      `${dryRun ? "would clean" : "cleaned"} ${target.label}: ${target.path} (${count} item${count === 1 ? "" : "s"})`,
    );
  }
}

function assertSafeTarget(targetPath: string): void {
  const resolvedTarget = resolve(targetPath);
  const relativePath = relative(STATE_ROOT, resolvedTarget);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing to clean a path outside the repository runtime state: ${resolvedTarget}`,
    );
  }
}

async function cleanDirectory(
  targetPath: string,
  dryRun: boolean,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (dryRun) return 0;
    await mkdir(targetPath, { recursive: true });
    entries = [];
  }
  if (!dryRun) {
    await Promise.all(
      entries.map((entry) =>
        rm(join(targetPath, entry), { recursive: true, force: true }),
      ),
    );
  }
  return entries.length;
}
