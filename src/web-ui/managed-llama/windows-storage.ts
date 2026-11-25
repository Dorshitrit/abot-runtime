import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { ManagedLlamaError } from "./contracts.js";
import { windowsSystemRoot } from "./process-environment.js";
import { publishWindowsStorageFailure } from "./windows-storage-diagnostics.js";

const execute = promisify(execFile);
const timeoutMs = 10_000;
// Caller may claim ONLY a path it just exclusively created, before writing data.
// Never repair or adopt existing storage. Paths are data, never script fragments.
// Framework ACL methods avoid module discovery for each isolated helper process.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
$PSModuleAutoLoadingPreference = 'None'
$target = $env:ABOT_LLAMA_PATH
$mode = $env:ABOT_LLAMA_ACCESS
$root = [IO.Path]::GetPathRoot($target)
if ($root -notmatch '^[A-Za-z]:\\$') { throw 'local_drive_required' }
$cursor = $target
while ($cursor) {
  if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse_point' }
  $cursor = [IO.Path]::GetDirectoryName($cursor)
}
if ($mode -eq 'path') { exit 0 }
if (([IO.DriveInfo]::new($root)).DriveFormat -ne 'NTFS') { throw 'ntfs_required' }
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$isDirectory = ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::Directory) -ne 0
$item = if ($isDirectory) { [IO.DirectoryInfo]::new($target) } else { [IO.FileInfo]::new($target) }
if ($mode -eq 'create-directory' -or $mode -eq 'create-file') {
  if ($isDirectory -ne ($mode -eq 'create-directory')) { throw 'type_changed' }
  $acl = if ($isDirectory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $item.SetAccessControl($acl)
}
$observed = $item.GetAccessControl()
if ($observed.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { throw 'foreign_owner' }
$allowed = @($current.Value, 'S-1-5-18', 'S-1-5-32-544')
$currentAccess = $false
foreach ($rule in $observed.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
  if ($rule.IdentityReference.Value -notin $allowed) { throw 'public_access' }
  if ($rule.IdentityReference.Value -eq $current.Value -and -not $rule.IsInherited) { $currentAccess = $true }
}
if (-not $currentAccess) { throw 'missing_private_access' }
`;

export type WindowsStorageAccess = "path" | "private" | "create-directory" | "create-file";
export async function verifyWindowsLlamaStorage(path: string, access: WindowsStorageAccess = "private"): Promise<void> {
  const SystemRoot = windowsSystemRoot();
  const startedAt = performance.now();
  try {
    await execute(win32.join(SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16_384,
        env: { SystemRoot, PATH: win32.join(SystemRoot, "System32"), ABOT_LLAMA_PATH: path, ABOT_LLAMA_ACCESS: access } });
  } catch (error) {
    publishWindowsStorageFailure(error, access, performance.now() - startedAt, timeoutMs);
    throw new ManagedLlamaError("storage_unavailable", "Private Windows storage could not be verified.");
  }
}
