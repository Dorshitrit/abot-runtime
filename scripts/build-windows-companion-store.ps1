param(
  [Parameter(Mandatory = $true)][string]$LayoutDirectory,
  [Parameter(Mandatory = $true)][string]$MakeAppxPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$layout = (Resolve-Path -LiteralPath $LayoutDirectory).ProviderPath
$packager = (Resolve-Path -LiteralPath $MakeAppxPath).ProviderPath
$signature = Get-AuthenticodeSignature -LiteralPath $packager
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation,') {
  throw 'Use MakeAppx from a verified Microsoft Windows SDK.'
}
if (Test-Path -LiteralPath $OutputPath) { throw 'Choose a new output path; existing packages are not overwritten.' }
foreach ($name in @('node.exe', 'companion.mjs', 'AppxManifest.xml', 'Assets\Companion.ico')) {
  if (-not (Test-Path -LiteralPath (Join-Path $layout $name) -PathType Leaf)) { throw "Incomplete layout: $name" }
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\computer-access\companion\windows-store\desktop'
$sources = @(Get-ChildItem -LiteralPath $source -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { throw 'Companion desktop sources are missing.' }
$executable = Join-Path $layout 'ABotCompanion.exe'
$icon = Join-Path $layout 'Assets\Companion.ico'
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /warnaserror+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/win32icon:$icon" "/out:$executable" @sources
if ($LASTEXITCODE -ne 0) { throw "Companion desktop compile failed: $LASTEXITCODE" }
& $packager pack /d $layout /p $OutputPath
if ($LASTEXITCODE -ne 0) { throw "MSIX validation or packaging failed: $LASTEXITCODE" }
Write-Output 'Unsigned MSIX built and validated. No app was installed or registered.'
