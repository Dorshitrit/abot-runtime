import { spawn, type ChildProcess } from "node:child_process";
import { dirname, win32 } from "node:path";
import { llamaProcessEnvironment, windowsSystemRoot } from "../process-environment.js";
import type { Spawn } from "../contracts.js";
import { WINDOWS_LLAMA_JOB } from "./windows-process-job.js";

/** cache is the private run directory already created and written by createServerPresets.
 * PowerShell 5.1 compilation needs writable temp storage without inheriting host env.
 */
export function serverProcessEnvironment(token: string, cache: string, os: string = process.platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...llamaProcessEnvironment(token, os, source), LLAMA_CACHE: cache };
  if (os !== "win32") return env;
  return { ...env, TMP: cache, TEMP: cache };
}

export const spawnServerTree: Spawn = (file, args, options) => {
  if (process.platform === "win32") {
    const root = windowsSystemRoot();
    return spawn(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_LLAMA_JOB, "utf16le").toString("base64")],
      { ...options, shell: false, windowsHide: true, detached: false,
        env: { ...options.env, ABOT_LLAMA_COMMAND_JSON: JSON.stringify({ file, args, cwd: dirname(file) }) } });
  }
  const child = spawn(file, args, { ...options, shell: false, detached: true });
  // A router exit must not leave its model children behind.
  child.once("exit", () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already gone. */ } } });
  return child;
};
export function signalServerTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") { child.kill(signal); return; }
  if (child.pid) process.kill(-child.pid, signal);
}
