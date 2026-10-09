import { join } from "node:path";
import type { NativeAutostartOptions } from "./autostart.js";

function vbsText(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error("Unsupported Companion path.");
  return '"' + value.replaceAll('"', '""') + '"';
}

export function renderWindowsInstallLinkLauncher(
  options: NativeAutostartOptions,
): string {
  if (/["\r\n\0]/u.test(options.nodePath + options.cliPath))
    throw new Error("Unsupported Companion path.");
  const prefix = `"${options.nodePath}" "${options.cliPath}" host open-link --encoded `;
  return [
    "' ABot managed installation links",
    "If WScript.Arguments.Count <> 1 Then WScript.Quit 1",
    "value = WScript.Arguments(0)",
    "If InStr(value, Chr(34)) > 0 Or InStr(value, vbCr) > 0 Or InStr(value, vbLf) > 0 Then WScript.Quit 1",
    "If Len(value) > 2048 Then WScript.Quit 1",
    'Set stream = CreateObject("ADODB.Stream")',
    "stream.Type = 2",
    'stream.Charset = "utf-8"',
    "stream.Open",
    "stream.WriteText value",
    "stream.Position = 0",
    "stream.Type = 1",
    "stream.Position = 3",
    'Set document = CreateObject("Msxml2.DOMDocument.6.0")',
    'Set encoded = document.createElement("encoded")',
    'encoded.dataType = "bin.base64"',
    "encoded.nodeTypedValue = stream.Read",
    "stream.Close",
    'value = Replace(Replace(encoded.text, vbCr, ""), vbLf, "")',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${vbsText(prefix)} & value, 0, False`,
    "",
  ].join("\r\n");
}

export function windowsInstallLinkRegistryScript(
  action: "install" | "remove",
  launcher: string,
): string {
  const quoted = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const command = `wscript.exe "${launcher}" "%1"`;
  return `
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\\Software\\Classes\\abot'
$expected = ${quoted(launcher)}
$exists = Test-Path -LiteralPath $key
function Assert-OwnedInstallLinkRegistration([string]$path) {
  if (!(Test-Path -LiteralPath $path)) { return }
  $owner = (Get-ItemProperty -LiteralPath $path -Name ABotInstallLinkOwner -ErrorAction SilentlyContinue).ABotInstallLinkOwner
  if ($owner -ne $expected) { throw 'The abot protocol belongs to another application.' }
}
Assert-OwnedInstallLinkRegistration $key
${
  action === "remove"
    ? "if ($exists) { Remove-Item -LiteralPath $key -Recurse -Force }"
    : `
Assert-OwnedInstallLinkRegistration 'Registry::HKEY_CLASSES_ROOT\\abot'
New-Item -Path $key -Force | Out-Null
Set-Item -LiteralPath $key -Value 'URL:ABot installation'
New-ItemProperty -LiteralPath $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $key -Name ABotInstallLinkOwner -Value $expected -PropertyType String -Force | Out-Null
New-Item -Path ($key + '\\shell\\open\\command') -Force | Out-Null
Set-Item -LiteralPath ($key + '\\shell\\open\\command') -Value ${quoted(command)}
`
}
`;
}

export function windowsInstallLinkLauncherPath(
  options: NativeAutostartOptions,
): string {
  return join(options.stateDir, "install-links", "open-link.vbs");
}
