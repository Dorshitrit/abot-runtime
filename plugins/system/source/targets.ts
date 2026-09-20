import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  SystemOperationError,
  type SystemProcessRunner,
  type SystemTarget,
  type SystemTargetId,
} from "./contracts.js";
import { runSystemProcess } from "./process-runner.js";
import { isWslHostRuntime, readSystemHostFacts } from "./host-observation.js";

export function powershellArguments(script: string): string[] {
  const preamble =
    "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$global:LASTEXITCODE=0;";
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(preamble + script, "utf16le").toString("base64"),
  ];
}
export function powershellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}
export function shellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function windowsSystemCommandScript(
  command: string,
  cwd: string,
): string {
  return `Set-Location -LiteralPath ${powershellLiteral(cwd)};${command}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
}

export async function findExecutable(
  name: string,
  additional: readonly string[] = [],
): Promise<string | undefined> {
  const candidates = [
    ...additional,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, name)),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next observed candidate */
    }
  }
  return undefined;
}

export async function resolveSystemTarget(
  id: SystemTargetId,
  run: SystemProcessRunner = runSystemProcess,
): Promise<SystemTarget> {
  if (isNativeUnixTarget(id)) return resolveNativeUnixTarget(id);
  if (id !== "windows")
    throw new SystemOperationError(
      "system_target_unavailable",
      `The runtime is not executing on ${id}.`,
    );
  const nativeWindows = process.platform === "win32";
  const wslWindows = isWslHostRuntime(readSystemHostFacts());
  if (!hasWindowsExecutionTransport(nativeWindows, wslWindows))
    throw new SystemOperationError(
      "system_target_unavailable",
      "No Windows execution transport is available on this host.",
    );
  const canonicalShell = nativeWindows
    ? join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const shell = await findExecutable("powershell.exe", [canonicalShell]);
  if (!shell)
    throw new SystemOperationError(
      "system_target_unavailable",
      "A native Windows PowerShell executable was not found; Windows interop is unavailable.",
    );
  const probe = await run({
    executable: shell,
    args: powershellArguments("[Environment]::OSVersion.Platform.ToString()"),
    timeoutMs: 5_000,
  });
  if (!hasObservedWindowsPlatform(probe))
    throw new SystemOperationError(
      "system_target_unavailable",
      "Windows PowerShell could not execute. WSL executable interop may be disabled; enable a real Windows execution transport on the host.",
    );
  return { id, transport: nativeWindows ? "native" : "wsl_interop", shell };
}

export function readSystemTargetId(value: unknown): SystemTargetId {
  if (value === "linux" || value === "macos" || value === "windows")
    return value;
  throw new SystemOperationError(
    "system_target_required",
    "Select an explicit target returned by system_targets: linux, macos, or windows.",
  );
}

function isNativeUnixTarget(id: SystemTargetId): boolean {
  if (id === "linux") return process.platform === "linux";
  if (id === "macos") return process.platform === "darwin";
  return false;
}

async function resolveNativeUnixTarget(
  id: SystemTargetId,
): Promise<SystemTarget> {
  try {
    await access("/bin/bash", constants.X_OK);
  } catch {
    throw new SystemOperationError(
      "system_target_unavailable",
      "The native target has no executable /bin/bash.",
    );
  }
  return { id, transport: "native", shell: "/bin/bash" };
}

function hasWindowsExecutionTransport(
  nativeWindows: boolean,
  wslWindows: boolean,
): boolean {
  if (nativeWindows) return true;
  return wslWindows;
}
function hasObservedWindowsPlatform(
  probe: Awaited<ReturnType<SystemProcessRunner>>,
): boolean {
  if (probe.status !== "completed") return false;
  if (probe.exitCode !== 0) return false;
  return probe.stdout.trim() === "Win32NT";
}
