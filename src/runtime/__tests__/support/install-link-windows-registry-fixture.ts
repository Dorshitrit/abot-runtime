import { windowsInstallLinkRegistryScript } from "../../../computer-access/companion/install-link-windows.js";

export const windowsLinkTestOwner = "C:\\ABot\\open-link.vbs";

/** All registry commands are replaced; the generated production script cannot access the real registry. */
export function installLinkRegistryProbe(
  action: "install" | "remove",
  userOwner: string | null,
  mergedOwner: string | null,
): string {
  const payload = JSON.stringify({ userOwner, mergedOwner }).replaceAll(
    "'",
    "''",
  );
  return String.raw`
$ErrorActionPreference = 'Stop'
$Case = '${payload}' | ConvertFrom-Json
$UserKey = 'HKCU:\Software\Classes\abot'
$MergedKey = 'Registry::HKEY_CLASSES_ROOT\abot'
$Writes = [System.Collections.Generic.List[string]]::new()
function Test-Path([string]$LiteralPath) {
  if ($LiteralPath -eq $UserKey) { return $null -ne $Case.userOwner }
  if ($LiteralPath -eq $MergedKey) { return $null -ne $Case.mergedOwner }
  throw 'Unexpected registry probe path'
}
function Get-ItemProperty([string]$LiteralPath, [string]$Name, [string]$ErrorAction) {
  if ($LiteralPath -eq $UserKey) { return @{ ABotInstallLinkOwner = $Case.userOwner } }
  if ($LiteralPath -eq $MergedKey) { return @{ ABotInstallLinkOwner = $Case.mergedOwner } }
  throw 'Unexpected registry property path'
}
function New-Item([string]$Path, [switch]$Force) { $Writes.Add('create:' + $Path) }
function Set-Item([string]$LiteralPath, [string]$Value) { $Writes.Add('set:' + $LiteralPath) }
function New-ItemProperty([string]$LiteralPath, [string]$Name, [string]$Value, [string]$PropertyType, [switch]$Force) { $Writes.Add('property:' + $LiteralPath) }
function Remove-Item([string]$LiteralPath, [switch]$Recurse, [switch]$Force) { $Writes.Add('remove:' + $LiteralPath) }
$Rejected = $false
$Failure = ''
try {
  & {
${windowsInstallLinkRegistryScript(action, windowsLinkTestOwner)}
  }
} catch {
  $Rejected = $true
  $Failure = $_.Exception.Message
}
[pscustomobject]@{ Rejected = $Rejected; Writes = @($Writes.ToArray()); Failure = $Failure } | ConvertTo-Json -Compress
`;
}
