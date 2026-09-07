import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Paths travel through an environment value, never through shell interpolation.
const privateAccessScript = `
$ErrorActionPreference = 'Stop'
$target = $env:ABOT_LOCAL_HOST_PRIVATE_PATH
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 }
if ($env:ABOT_LOCAL_HOST_CREATE_PRIVATE -eq '1') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($current, 'FullControl', $inherit, $propagate, $allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
$observed = Get-Acl -LiteralPath $target
$owner = $observed.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $current.Value) { exit 3 }
$allowed = @($current.Value, 'S-1-5-18', 'S-1-5-32-544')
$rules = $observed.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$currentCanRead = $false
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  if ($rule.IdentityReference.Value -notin $allowed) { exit 4 }
  if ($rule.IdentityReference.Value -eq $current.Value) { $currentCanRead = $true }
}
if (-not $currentCanRead) { exit 5 }
`;

export async function verifyWindowsPrivateAccess(
  path: string,
  newlyCreatedDirectory = false,
): Promise<void> {
  await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(privateAccessScript, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16_384,
      env: {
        ...process.env,
        ABOT_LOCAL_HOST_PRIVATE_PATH: path,
        ABOT_LOCAL_HOST_CREATE_PRIVATE: newlyCreatedDirectory ? "1" : "0",
      },
    },
  );
}
