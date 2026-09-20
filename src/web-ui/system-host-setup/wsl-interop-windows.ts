import { installerMetadataBase64 } from "./installer-contract.js";
import { renderWslInteropShell } from "./wsl-interop-config.js";
import { wrapWindowsSetupScript } from "./windows-script-wrapper.js";

export function renderWindowsWslInteropScript(distribution?: string): string {
  const metadata = installerMetadataBase64({ distribution });
  const shell = Buffer.from(renderWslInteropShell(), "utf8").toString("base64");
  return wrapWindowsSetupScript(String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Metadata = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${metadata}')) | ConvertFrom-Json
$Wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
try {
  $Installed = @(& $Wsl --list --quiet)
  if ($LASTEXITCODE -ne 0) { throw 'Windows could not list the installed WSL distributions.' }
  $Distributions = @($Installed | ForEach-Object { $_.Replace([string][char]0, '').Trim() } | Where-Object { $_ -and -not $_.StartsWith('docker-desktop', [StringComparison]::OrdinalIgnoreCase) })
  $Selected = $Metadata.distribution
  if ($Selected) {
    if (-not ($Distributions -ccontains $Selected)) { throw 'The requested WSL distribution is not installed with that exact name.' }
  } elseif ($Distributions.Count -eq 1) {
    $Selected = $Distributions[0]
  } elseif ($Distributions.Count -gt 1) {
    Write-Host 'Choose the WSL distribution used by ABot:'
    for ($Index = 0; $Index -lt $Distributions.Count; $Index++) { Write-Host (($Index + 1).ToString() + '. ' + $Distributions[$Index]) }
    $Choice = Read-Host 'Distribution number (Enter cancels)'
    if (-not $Choice) { Write-Host 'Cancelled. No settings were changed.'; exit 0 }
    $Number = 0
    if (-not [int]::TryParse($Choice, [ref]$Number) -or $Number -lt 1 -or $Number -gt $Distributions.Count) { throw 'The distribution selection is invalid.' }
    $Selected = $Distributions[$Number - 1]
  } else { throw 'No supported WSL distribution is installed.' }
  Write-Host ('This will enable Windows executable interoperability in ' + $Selected + '.')
  Write-Host 'It preserves other WSL settings and saves the previous configuration.'
  Write-Host ('Restarting ' + $Selected + ' will interrupt ALL apps and services in that distribution, including ABot. Other distributions will remain running.') -ForegroundColor Yellow
  $ShellBase64 = '${shell}'
  $ShellBase64 | & $Wsl --distribution $Selected --user root --exec /bin/sh -c "tr -d '\r\n' | base64 -d | /bin/sh"
  if ($LASTEXITCODE -ne 0) { throw 'WSL configuration could not be updated. The distribution was not restarted.' }
  & $Wsl --terminate $Selected
  if ($LASTEXITCODE -ne 0) { throw 'The selected distribution did not stop. Its configuration is saved, but restart still needs to complete.' }
  $PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $LinuxPowerShell = @(& $Wsl --distribution $Selected --exec wslpath -u $PowerShell)
  if ($LASTEXITCODE -ne 0 -or $LinuxPowerShell.Count -ne 1) { throw 'The distribution restarted, but its Windows executable path could not be resolved.' }
  $Probe = @(& $Wsl --distribution $Selected --exec ($LinuxPowerShell[0].Trim()) -NoLogo -NoProfile -NonInteractive -Command '[Environment]::OSVersion.Platform.ToString()')
  if ($LASTEXITCODE -ne 0 -or ($Probe -join '').Trim() -ne 'Win32NT') { throw 'The distribution restarted, but actual Windows PowerShell execution is still unavailable.' }
  Write-Host ('Verified: Windows PowerShell can run through ' + $Selected + '. Return to ABot and check again.')
} catch {
  Write-Host ('WSL setup failed: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
`);
}
