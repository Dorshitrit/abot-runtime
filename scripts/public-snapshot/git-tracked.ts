import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { assertSafeSnapshotRelativePath } from "./manifest.js";

const execFileAsync = promisify(execFile);

async function runGit(
  sourceRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  }).catch((error: unknown) => {
    throw new Error(
      `unable to inspect tracked public files: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return result.stdout;
}

export async function assertExactGitRoot(sourceRoot: string): Promise<void> {
  const declared = await realpath(sourceRoot);
  const reported = (
    await runGit(sourceRoot, ["rev-parse", "--show-toplevel"])
  ).trim();
  if ((await realpath(reported)) !== declared) {
    throw new Error("public snapshot sourceRoot must be the exact Git root");
  }
}

export async function assertCleanGitWorktree(
  sourceRoot: string,
): Promise<void> {
  const status = await runGit(sourceRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.length > 0) {
    throw new Error(
      "public snapshot source Git worktree must be clean before export",
    );
  }
}

export async function listTrackedSnapshotFiles(params: {
  sourceRoot: string;
  directories: readonly string[];
  files: readonly string[];
}): Promise<ReadonlySet<string>> {
  const output = await runGit(params.sourceRoot, [
    "ls-files",
    "-z",
    "--",
    ...params.directories,
    ...params.files,
  ]);
  const paths = output.split("\0").filter((path) => path.length > 0);
  for (const path of paths) {
    assertSafeSnapshotRelativePath(path);
    if (
      !params.files.includes(path) &&
      !params.directories.some((directory) => path.startsWith(`${directory}/`))
    ) {
      throw new Error(
        `Git returned a path outside the selected snapshot: ${path}`,
      );
    }
  }
  return new Set(paths);
}
