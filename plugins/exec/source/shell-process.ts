import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { execShell } from "./shell-platform.js";
import { WINDOWS_EXEC_BOOTSTRAP } from "./windows-shell-bootstrap.js";
import { WINDOWS_EXEC_JOB_SOURCE } from "./windows-job-source.js";

export type ExecChild = ChildProcessByStdio<
  Writable | null,
  Readable,
  Readable
>;

export function spawnExecShell(command: string, cwd: string): ExecChild {
  if (process.platform !== "win32")
    return spawn(execShell(), ["-lc", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const child = spawn(
    execShell(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_EXEC_BOOTSTRAP, "utf16le").toString("base64"),
    ],
    { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  // Startup denial may close stdin early. The existing error/close path reports it.
  child.stdin.on("error", () => {});
  child.stdin.end(
    JSON.stringify({ source: WINDOWS_EXEC_JOB_SOURCE, command }),
    "utf8",
  );
  return child;
}

export function killExecProcessTree(child: ExecChild): void {
  if (process.platform === "win32") {
    // The Job Object closes with its owning shell and terminates its descendants.
    child.kill("SIGKILL");
    return;
  }
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Preserve the existing Unix best-effort direct-child fallback.
    }
  }
  child.kill("SIGKILL");
}
