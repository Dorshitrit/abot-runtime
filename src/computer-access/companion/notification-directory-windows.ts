import type { NotificationProcessRunner } from "./notification-process.js";
import { powershellNotificationArguments } from "./notification-windows.js";

const WINDOWS_PUBLISH_DIRECTORY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$Payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
[System.IO.Directory]::Move([string]$Payload.source, [string]$Payload.destination)
`;

/** Directory.Move uses the Windows move primitive without replacement. */
export async function publishWindowsNotificationDirectory(
  source: string,
  destination: string,
  run: NotificationProcessRunner,
): Promise<void> {
  await run({
    file: "powershell.exe",
    args: powershellNotificationArguments(WINDOWS_PUBLISH_DIRECTORY),
    input: JSON.stringify({ source, destination }),
  });
}
