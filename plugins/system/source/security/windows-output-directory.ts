import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { SystemOperationError } from "../../../../src/plugin-sdk/computer-access.js";

const execute = promisify(execFile);
// The empty candidate is secured before publication. Paths remain environment data.
const privateDirectoryScript = `
$env:PSModulePath = "$PSHOME\\Modules"
$ErrorActionPreference = 'Stop'
$target = $env:ABOT_SYSTEM_OUTPUT_DIRECTORY
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $target -Force
if (-not $item.PSIsContainer) { exit 2 }
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 }
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
if ($env:ABOT_SYSTEM_OUTPUT_CREATE_PRIVATE -eq '1') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($current, 'FullControl', $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
$observed = Get-Acl -LiteralPath $target
if ($observed.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { exit 3 }
if (-not $observed.AreAccessRulesProtected) { exit 4 }
$rules = @($observed.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { exit 5 }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $current.Value) { exit 5 }
if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 5 }
if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 5 }
if ($rule.InheritanceFlags -ne $inherit) { exit 5 }
if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { exit 5 }
`;

async function verifyPrivateOutputDirectory(directory: string, create = false): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("output_directory_unavailable");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(privateDirectoryScript, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
    env: { ...process.env, ABOT_SYSTEM_OUTPUT_DIRECTORY: directory, ABOT_SYSTEM_OUTPUT_CREATE_PRIVATE: create ? "1" : "0" },
  });
}

function isAbsentPath(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT";
}
async function hasOutputDirectoryPath(directory: string): Promise<boolean> {
  try { await lstat(directory); return true; }
  catch (error) { if (isAbsentPath(error)) return false; throw error; }
}

async function installPrivateOutputDirectory(directory: string): Promise<void> {
  if (await hasOutputDirectoryPath(directory)) return;
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const candidate = await mkdtemp(join(parent, `.${basename(directory)}.private-`));
  try {
    await verifyPrivateOutputDirectory(candidate, true);
    try { await rename(candidate, directory); }
    catch (error) { if (!await hasOutputDirectoryPath(directory)) throw error; }
  } finally {
    await rmdir(candidate).catch(error => { if (!isAbsentPath(error)) throw error; });
  }
}

/** Windows raw output stays below a verified inheritable private DACL, before dispatch. */
export async function ensureWindowsOutputDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await installPrivateOutputDirectory(directory);
    await verifyPrivateOutputDirectory(directory);
  } catch {
    throw new SystemOperationError("system_output_storage_failed", "Private output storage could not be prepared. The command was not dispatched.");
  }
}
