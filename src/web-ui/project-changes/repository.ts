import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ProjectChangesError } from "./contracts.js";
import { createProjectGitRead, projectGitExecutable, requireGitRead, type GitRead } from "./git-process.js";
import type { ProjectChangesAuthority } from "./access.js";

export type ProjectGitRepository = { git: GitRead; head: string | null; prefix: string; root: string; indexVersion: string; indexMtimeNs: bigint | null; fileMode: boolean; autocrlf: "false" | "true" | "input"; eol: string };
export function isProjectRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\\")) return false;
  if (path.split("/").some((part) => part === ".." || part === "." || !part)) return false;
  return !/^[A-Za-z]:/u.test(path);
}
function gitLine(value: Buffer): string { return value.toString("utf8").replace(/\r?\n$/u, ""); }

export async function requireSafeGitConfiguration(git: GitRead): Promise<void> {
  const configured = await git(["config", "--null", "--get-regexp", "^(filter\\..*\\.(clean|process)|extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"]);
  if (configured.code === 1) return;
  for (const record of requireGitRead(configured).toString("utf8").split("\0")) {
    const separator = record.indexOf("\n");
    if (separator < 0) continue;
    const key = record.slice(0, separator).toLowerCase();
    const value = record.slice(separator + 1).trim();
    if (key.endsWith(".promisor") && /^(?:false|no|off|0)$/iu.test(value)) continue;
    if (key.startsWith("filter.") && !value) continue;
    if (!key.startsWith("filter."))
      throw new ProjectChangesError("project_changes_partial_clone_unsupported", "Preview is unavailable for partial-clone repositories.", 415);
    throw new ProjectChangesError("project_changes_filters_unsupported", "Preview is unavailable for repositories with configured clean or process filters.", 415);
  }
}

export async function openProjectGitRepository(authority: ProjectChangesAuthority, signal?: AbortSignal): Promise<ProjectGitRepository> {
  await authority.assertCurrent();
  const git = createProjectGitRead(await projectGitExecutable(), authority.directory, signal);
  const discovered = await git(["rev-parse", "--show-toplevel"]);
  if (discovered.code !== 0 && discovered.stderr.includes("not a git repository"))
    throw new ProjectChangesError("not_git", "This project is not inside a Git working tree.");
  const root = await realpath(gitLine(requireGitRead(discovered)));
  const prefix = relative(root, authority.directory).split(sep).join("/");
  if (prefix && !isProjectRelativePath(prefix))
    throw new ProjectChangesError("project_changes_unavailable", "The repository does not contain the project directory.", 403);
  await requireSafeGitConfiguration(git);
  const headResult = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (headResult.code !== 0 && headResult.code !== 1) requireGitRead(headResult);
  const head = headResult.code === 0 ? gitLine(headResult.stdout) : null;
  if (head !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head))
    throw new ProjectChangesError("project_changes_unavailable", "Git returned an unsupported revision.");
  const indexPath = gitLine(requireGitRead(await git(["rev-parse", "--git-path", "index"])));
  const index = await stat(resolve(authority.directory, indexPath), { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const indexVersion = index ? [index.dev, index.ino, index.size, index.mtimeNs, index.ctimeNs].map(String).join(":") : "absent";
  const modeResult = await git(["config", "--bool", "--get", "core.filemode"]);
  if (modeResult.code !== 0 && modeResult.code !== 1) requireGitRead(modeResult);
  const fileMode = modeResult.code === 1 || gitLine(modeResult.stdout) !== "false";
  const conversion = await git(["config", "--null", "--get-regexp", "^core\\.(autocrlf|eol)$"]);
  if (conversion.code !== 0 && conversion.code !== 1) requireGitRead(conversion);
  let autocrlf: "false" | "true" | "input" = "false";
  let eol = "native";
  for (const record of conversion.stdout.toString("utf8").split("\0")) {
    const [key, raw] = record.split("\n");
    const value = raw?.toLowerCase() ?? "";
    if (key?.toLowerCase() === "core.eol") eol = value;
    if (key?.toLowerCase() !== "core.autocrlf") continue;
    if (value === "input") autocrlf = "input";
    else if (["true", "yes", "on", "1", ""].includes(value)) autocrlf = "true";
    else if (["false", "no", "off", "0"].includes(value)) autocrlf = "false";
    else throw new ProjectChangesError("project_changes_unavailable", "Git line-ending configuration is unsupported.");
  }
  await authority.assertCurrent();
  return { git, head, prefix, root, indexVersion, indexMtimeNs: index?.mtimeNs ?? null, fileMode, autocrlf, eol };
}
