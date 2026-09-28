import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
type IdentityCommandOptions = Readonly<{
  env: NodeJS.ProcessEnv;
  windowsHide: true;
  timeout: number;
  maxBuffer: number;
}>;
export type ProcessOwnerIdentityDependencies = Readonly<{
  platform: NodeJS.Platform;
  currentPid: number;
  readText(path: string): Promise<string>;
  execute(
    file: string,
    args: readonly string[],
    options: IdentityCommandOptions,
  ): Promise<string>;
  processIsAlive(pid: number): boolean;
}>;

const WINDOWS_OWNER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targetPid = [int]$env:ABOT_HOST_OWNER_PID
$target = Get-Process -Id $targetPid -ErrorAction Stop
$started = $target.StartTime.ToUniversalTime().Ticks
[Console]::Out.Write([string]$started)
`;

export function hasSameProcessOwnerIdentity(
  recorded: string,
  observed: string,
): boolean {
  if (recorded === observed) return true;
  // Legacy Windows records also included a WMI boot time that can drift while
  // the same process runs. Keep its exact creation ticks; never round them.
  const windowsCreation = /^windows:(?:\d{10,20}\|)?(\d{10,20})$/u;
  const recordedStart = windowsCreation.exec(recorded)?.[1];
  if (!recordedStart) return false;
  return recordedStart === windowsCreation.exec(observed)?.[1];
}

function isProcessId(pid: number): boolean {
  if (!Number.isSafeInteger(pid)) return false;
  return pid > 0;
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
function observePidLiveness(pid: number): boolean {
  if (!isProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error)) return true;
    return error.code !== "ESRCH";
  }
}

async function linuxIdentity(
  pid: number,
  dependencies: ProcessOwnerIdentityDependencies,
): Promise<string | undefined> {
  const [bootText, processText] = await Promise.all([
    dependencies.readText("/proc/sys/kernel/random/boot_id"),
    dependencies.readText(`/proc/${pid}/stat`),
  ]);
  const boot = bootText.trim();
  if (!isUuid(boot)) return undefined;
  if (!processText.startsWith(`${pid} (`)) return undefined;
  const commandEnd = processText.lastIndexOf(") ");
  if (commandEnd < 0) return undefined;
  // After the final command-name parenthesis, index zero is stat field 3.
  const startTicks = processText
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u)[19];
  if (!startTicks || !/^\d+$/u.test(startTicks)) return undefined;
  return `linux:${boot.toLowerCase()}:${startTicks}`;
}

function commandOptions(pid: number): IdentityCommandOptions {
  return {
    env: {
      ...process.env,
      ABOT_HOST_OWNER_PID: String(pid),
      LC_ALL: "C",
      TZ: "UTC",
    },
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 4_096,
  };
}

async function windowsIdentity(
  pid: number,
  dependencies: ProcessOwnerIdentityDependencies,
): Promise<string | undefined> {
  const text = await dependencies.execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_OWNER_SCRIPT, "utf16le").toString("base64"),
    ],
    commandOptions(pid),
  );
  const value = text.trim();
  if (!/^\d{10,20}$/u.test(value)) return undefined;
  return `windows:${value}`;
}

async function macIdentity(
  pid: number,
  dependencies: ProcessOwnerIdentityDependencies,
): Promise<string | undefined> {
  const [bootText, startedText] = await Promise.all([
    dependencies.execute(
      "/usr/sbin/sysctl",
      ["-n", "kern.bootsessionuuid"],
      commandOptions(pid),
    ),
    dependencies.execute(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      commandOptions(pid),
    ),
  ]);
  const boot = bootText.trim();
  const started = startedText.trim().replace(/\s+/gu, " ");
  if (!isUuid(boot)) return undefined;
  if (
    !/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(started)
  )
    return undefined;
  return `macos:${boot.toLowerCase()}:${started}`;
}

export function createProcessOwnerIdentityProbe(
  dependencies: ProcessOwnerIdentityDependencies,
) {
  async function readProcessOwnerIdentity(
    pid: number,
  ): Promise<string | undefined> {
    if (!isProcessId(pid)) return undefined;
    try {
      if (dependencies.platform === "linux")
        return await linuxIdentity(pid, dependencies);
      if (dependencies.platform === "win32")
        return await windowsIdentity(pid, dependencies);
      if (dependencies.platform === "darwin")
        return await macIdentity(pid, dependencies);
      return undefined;
    } catch {
      return undefined;
    }
  }
  async function isProcessOwnerAlive(
    pid: number,
    ownerIdentity?: string,
  ): Promise<boolean> {
    if (!isProcessId(pid)) return false;
    if (!dependencies.processIsAlive(pid)) return false;
    if (!ownerIdentity) return true;
    const observed = await readProcessOwnerIdentity(pid);
    if (!observed) return true;
    return hasSameProcessOwnerIdentity(ownerIdentity, observed);
  }
  async function requireCurrentProcessOwnerIdentity(): Promise<string> {
    const identity = await readProcessOwnerIdentity(dependencies.currentPid);
    if (!identity)
      throw new Error(
        "The host companion could not establish this process's OS identity; its ownership lock was not acquired.",
      );
    return identity;
  }
  return {
    readProcessOwnerIdentity,
    isProcessOwnerAlive,
    requireCurrentProcessOwnerIdentity,
  };
}

const nativeProbe = createProcessOwnerIdentityProbe({
  platform: process.platform,
  currentPid: process.pid,
  readText: (path) => readFile(path, "utf8"),
  execute: async (file, args, options) =>
    (await executeFile(file, [...args], options)).stdout,
  processIsAlive: observePidLiveness,
});
export const readProcessOwnerIdentity = nativeProbe.readProcessOwnerIdentity;
export const isProcessOwnerAlive = nativeProbe.isProcessOwnerAlive;
export const requireCurrentProcessOwnerIdentity =
  nativeProbe.requireCurrentProcessOwnerIdentity;
