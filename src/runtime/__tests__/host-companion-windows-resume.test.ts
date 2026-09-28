import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { renderWindowsCompanionScript } from "../../web-ui/system-host-setup/companion-windows.js";

const windowsPowerShell =
  process.platform === "win32"
    ? "powershell.exe"
    : process.env.ABOT_TEST_WINDOWS_INTEROP_SETUP === "1"
      ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
      : undefined;

test.skipIf(!windowsPowerShell)(
  "Windows cached resume requires pairing plus both exact build files",
  () => {
    const script = renderWindowsCompanionScript({
      platform: "windows",
      url: "http://127.0.0.1:5184",
      code: "a".repeat(43),
      bundleSha256: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const decision = script
      .split(/\r?\n/u)
      .find((line) => line.trimStart().startsWith("$CanResumeCached = "));
    expect(decision).toBeDefined();
    // Evaluate only the generated cache decision against a fake file probe.
    // No installer, download, startup registration or companion is executed.
    const probe = `
$ErrorActionPreference = 'Stop'
$ExistingConnection = 'connection'
$Node = 'node'
$Bundle = 'bundle'
function Test-Path([string]$LiteralPath, [string]$PathType) {
  if ($PathType -ne 'Leaf') { throw 'Expected exact cached files' }
  return $Present.Contains($LiteralPath)
}
$Results = @()
foreach ($Mask in 0..7) {
  $Present = @()
  if ($Mask -band 1) { $Present += 'connection' }
  if ($Mask -band 2) { $Present += 'node' }
  if ($Mask -band 4) { $Present += 'bundle' }
  ${decision}
  $Results += [bool]$CanResumeCached
}
ConvertTo-Json -Compress -InputObject $Results
`;
    const output = execFileSync(
      windowsPowerShell!,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(probe, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output.trim())).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  },
);
