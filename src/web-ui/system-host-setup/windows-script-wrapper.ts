/** The body is read from disk so ephemeral credentials never enter process argv. */
export function wrapWindowsSetupScript(script: string): string {
  const marker = "#==ABOT-POWERSHELL==";
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'set "ABOT_SETUP_FILE=%~f0"',
    `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -Command "$text = [IO.File]::ReadAllText($env:ABOT_SETUP_FILE); & ([ScriptBlock]::Create($text.Substring($text.LastIndexOf('${marker}') + ${marker.length})))"`,
    'set "ABOT_SETUP_RESULT=%ERRORLEVEL%"',
    "echo.",
    "pause",
    "exit /b %ABOT_SETUP_RESULT%",
    marker,
    script,
    "",
  ].join("\r\n");
}
