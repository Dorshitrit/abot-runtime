import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function initializePublicSnapshotGitFixture(
  sourceRoot: string,
): Promise<void> {
  await execFileAsync("git", ["-C", sourceRoot, "init", "--quiet"]);
  // A temporary fixture must not leave detached maintenance writing during cleanup.
  await execFileAsync("git", [
    "-C",
    sourceRoot,
    "config",
    "--local",
    "maintenance.auto",
    "false",
  ]);
}

export async function commitFixture(
  sourceRoot: string,
  message = "fixture state",
): Promise<void> {
  await execFileAsync("git", [
    "-C",
    sourceRoot,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  await execFileAsync("git", [
    "-C",
    sourceRoot,
    "config",
    "user.name",
    "Fixture",
  ]);
  await execFileAsync("git", ["-C", sourceRoot, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    sourceRoot,
    "commit",
    "--quiet",
    "--message",
    message,
  ]);
}
