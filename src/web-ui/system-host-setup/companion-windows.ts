import {
  installerMetadataBase64,
  type CompanionInstallerInput,
} from "./installer-contract.js";
import {
  COMPANION_NODE_DISTRIBUTIONS,
  COMPANION_NODE_VERSION,
} from "./node-distribution.js";
import { wrapWindowsSetupScript } from "./windows-script-wrapper.js";

export function renderWindowsCompanionScript(
  input: CompanionInstallerInput,
): string {
  const metadata = installerMetadataBase64({
    ...input,
    nodeVersion: COMPANION_NODE_VERSION,
    distributions: COMPANION_NODE_DISTRIBUTIONS,
  });
  return wrapWindowsSetupScript(String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Metadata = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${metadata}')) | ConvertFrom-Json
$Temporary = $null
function Assert-CompanionDirectory {
  if ((Get-Item -LiteralPath $Base).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The companion installation directory must not be a link.' }
}
function Invoke-VerifiedCompanionSetup {
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'The cached Node.js runtime is missing. Restore this installation before resuming setup.' }
  if (-not (Test-Path -LiteralPath $Bundle -PathType Leaf)) { throw 'The cached companion bundle is missing. Restore this installation before resuming setup.' }
  Assert-CompanionDirectory
  if ((& $Node --version) -ne $Metadata.nodeVersion -or $LASTEXITCODE -ne 0) { throw 'The dedicated Node.js runtime could not be verified.' }
  if ((Get-FileHash -LiteralPath $Bundle -Algorithm SHA256).Hash -ne $Metadata.bundleSha256) { throw 'The existing companion bundle does not match its recorded checksum.' }
  Write-Host 'Connecting this computer and enabling startup at sign-in...'
  $Payload = @{ url = $Metadata.url; code = $Metadata.code } | ConvertTo-Json -Compress
  $Payload | & $Node $Bundle setup
  if ($LASTEXITCODE -ne 0) { throw 'Companion setup did not complete. Check the message above before resuming setup.' }
  Write-Host 'Companion setup completed. Return to ABot to check the computer connection.'
}
function Get-VerifiedDownload([string]$Url, [string]$Destination, [string]$ExpectedHash, [string]$Bearer = '') {
  $Original = [Uri]$Url
  $Address = $Original
  if ($Original.Host -eq 'localhost' -or $Original.Host.EndsWith('.localhost')) {
    $Builder = New-Object UriBuilder($Original)
    $Builder.Host = '127.0.0.1'
    $Address = $Builder.Uri
  }
  $Request = [Net.HttpWebRequest]::Create($Address)
  $Request.Host = $Original.Authority
  $Request.AllowAutoRedirect = $false
  $Request.Timeout = 300000
  $Request.ReadWriteTimeout = 300000
  $Request.Proxy = $null
  if ($Bearer) { $Request.Headers['Authorization'] = 'Bearer ' + $Bearer }
  $Response = $null
  $File = $null
  try {
    $Response = $Request.GetResponse()
    if ([int]$Response.StatusCode -ne 200) { throw 'The download endpoint did not return a file.' }
    $File = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
    $Response.GetResponseStream().CopyTo($File)
  } finally {
    if ($File) { $File.Dispose() }
    if ($Response) { $Response.Dispose() }
  }
  if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $ExpectedHash) {
    throw 'Checksum verification failed. The downloaded file will not be executed.'
  }
}
try {
  $Base = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ABot\HostCompanion'
  $Architecture = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $Architecture = $env:PROCESSOR_ARCHITEW6432 }
  $Key = switch ($Architecture.ToUpperInvariant()) { 'AMD64' { 'win-x64' }; 'ARM64' { 'win-arm64' }; default { throw 'This Windows architecture is not supported by companion setup.' } }
  $Distribution = $Metadata.distributions.$Key
  $NodeDirectory = Join-Path $Base ([IO.Path]::GetFileNameWithoutExtension($Distribution.archive))
  $Node = Join-Path $NodeDirectory 'node.exe'
  $Bundle = Join-Path $Base ('companion-' + $Metadata.bundleSha256 + '.mjs')
  $ExistingConnection = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.abot\host-companion\connection.json'
  if (Test-Path -LiteralPath $ExistingConnection) {
    Invoke-VerifiedCompanionSetup
    exit 0
  }
  if ([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($Metadata.expiresAt)) { throw 'This setup invitation expired. Download a fresh setup file in ABot.' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  [IO.Directory]::CreateDirectory($Base) | Out-Null
  Assert-CompanionDirectory
  $Temporary = Join-Path $Base ('setup-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($Temporary) | Out-Null
  if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
    Write-Host 'Downloading the verified per-user Node.js runtime...'
    $Archive = Join-Path $Temporary 'node.zip'
    Get-VerifiedDownload ('https://nodejs.org/dist/' + $Metadata.nodeVersion + '/' + $Distribution.archive) $Archive $Distribution.sha256
    $Extracted = Join-Path $Temporary 'node'
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted
    Move-Item -LiteralPath (Join-Path $Extracted ([IO.Path]::GetFileNameWithoutExtension($Distribution.archive))) -Destination $NodeDirectory
  }
  Write-Host 'Downloading and verifying the ABot companion...'
  $Candidate = Join-Path $Temporary 'companion.mjs'
  Get-VerifiedDownload ($Metadata.url + '/web-api/runtime/system-host/bundle') $Candidate $Metadata.bundleSha256 $Metadata.code
  if (-not (Test-Path -LiteralPath $Bundle)) { Move-Item -LiteralPath $Candidate -Destination $Bundle }
  Invoke-VerifiedCompanionSetup
} catch {
  Write-Host ('Setup failed: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if ($Temporary -and (Test-Path -LiteralPath $Temporary)) {
    $ResolvedBase = [IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
    $ResolvedTemporary = [IO.Path]::GetFullPath($Temporary)
    if ($ResolvedTemporary.StartsWith($ResolvedBase, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $ResolvedTemporary -Recurse -Force }
  }
}
`);
}
