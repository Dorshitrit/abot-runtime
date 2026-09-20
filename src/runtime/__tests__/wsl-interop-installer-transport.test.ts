import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { renderWslInteropInstaller } from "../../web-ui/system-host-setup/installers.js";

const optedIntoWindowsInterop = process.env.ABOT_TEST_WINDOWS_INTEROP_SETUP === "1";

test.skipIf(!optedIntoWindowsInterop)("generated transport preserves a benign script through Windows PowerShell 5.1 native arguments", async () => {
  const distribution = process.env.ABOT_TEST_WINDOWS_INTEROP_DISTRO;
  if (!distribution) throw new Error("Set ABOT_TEST_WINDOWS_INTEROP_DISTRO to the explicit WSL test distribution.");
  const installer = await renderWslInteropInstaller({ distribution });
  const script = Buffer.from(installer.contentBase64, "base64").toString("utf8");
  const transportLines = script.split(/\r?\n/u).filter((line) => line.trimStart().startsWith("$ShellBase64 | & $Wsl "));
  expect(transportLines).toHaveLength(1);

  // Execute only the generated transport with this fixed harmless payload.
  // Never execute the installer body, its privileged configuration script or restart commands.
  const benignPayload = Buffer.from("printf '%s' 'transport-ok'\n", "utf8").toString("base64");
  const encodedDistribution = Buffer.from(distribution, "utf8").toString("base64");
  const probe = [
    "$ErrorActionPreference = 'Stop'",
    "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'This regression requires Windows PowerShell 5.1.' }",
    "$OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$Wsl = Join-Path $env:SystemRoot 'System32\\wsl.exe'",
    `$Selected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDistribution}'))`,
    `$ShellBase64 = '${benignPayload}'`,
    transportLines[0]!,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ].join("\n");
  const result = execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64"),
  ], { encoding: "utf8", timeout: 20_000 });
  expect(result.trim()).toBe("transport-ok");
}, 30_000);
