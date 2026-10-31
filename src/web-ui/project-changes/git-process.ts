import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { ProjectChangesError, PROJECT_GIT_BYTES } from "./contracts.js";

export type GitReadResult = { code: number; stdout: Buffer; stderr: string };
export type GitRead = (args: readonly string[], options?: { maxBytes?: number; input?: Buffer }) => Promise<GitReadResult>;

export async function projectGitExecutable(): Promise<string> {
  const name = process.platform === "win32" ? "git.exe" : "git";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const path = await realpath(join(directory, name));
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch { /* Try the next configured executable directory. */ }
  }
  throw new ProjectChangesError("git_unavailable", "Git is not available on the Runtime host.", 503);
}

export function projectGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  return { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", LC_ALL: "C" };
}

/** Only fixed read commands are supplied by this owner; no shell or browser command is accepted. */
export function createProjectGitRead(executable: string, directory: string, signal?: AbortSignal, limits: { timeoutMs?: number } = {}): GitRead {
  return (args, options = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ProjectChangesError("project_changes_unavailable", "The changes request was cancelled.")); return; }
    if ((options.input?.length ?? 0) > PROJECT_GIT_BYTES) { reject(new ProjectChangesError("project_changes_too_large", "Git input exceeds the preview limit.", 503)); return; }
    const child = spawn(executable, [
      "--no-pager", "--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "diff.autoRefreshIndex=false", ...args,
    ], { cwd: directory, env: projectGitEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let settled = false;
    const maximum = options.maxBytes ?? PROJECT_GIT_BYTES;
    const finishError = (message: string, code = "project_changes_unavailable") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      child.kill();
      reject(new ProjectChangesError(code, message, 503));
    };
    const timeout = setTimeout(() => finishError("Git did not finish within the preview time limit."), limits.timeoutMs ?? 5000);
    const abort = () => finishError("The changes request was cancelled.");
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) { finishError("Git output exceeds the preview limit.", "project_changes_too_large"); return; }
      destination.push(chunk);
    };
    child.stdout.on("data", collect(chunks));
    child.stderr.on("data", collect(errors));
    child.once("error", () => finishError("Git could not be started.", "git_unavailable"));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString("utf8") });
    });
  });
}

export function requireGitRead(result: GitReadResult): Buffer {
  if (result.code === 0) return result.stdout;
  throw new ProjectChangesError("project_changes_unavailable", "Git could not read this project with its current configuration.", 503);
}
