import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  NOTIFICATION_APP_ID,
  NOTIFICATION_OWNER_MARKER,
} from "../../computer-access/companion/notification-locations.js";
import {
  powershellNotificationArguments,
  sendWindowsNotification,
  WINDOWS_NOTIFICATION_IDENTITY_SCRIPT,
} from "../../computer-access/companion/notification-windows.js";

const windowsPowerShell =
  process.platform === "win32"
    ? "powershell.exe"
    : process.env.ABOT_TEST_WINDOWS_POWERSHELL;
const localizedError = "notification_test_failed: שגיאה בעברית 日本語";

function runWindowsScript(script: string, payload: unknown = {}) {
  const result = spawnSync(
    windowsPowerShell!,
    powershellNotificationArguments(script),
    {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  return result;
}

function isolatedIdentity() {
  const unique = randomUUID();
  const appId = "com.abot.notification-test." + unique;
  const mistakenAppId = "com.abot.notification-test-misdirected." + unique;
  const owner = "ABot notification test " + unique;
  const shortcut = "ABot notification test " + unique + ".lnk";
  const script = WINDOWS_NOTIFICATION_IDENTITY_SCRIPT.replaceAll(
    NOTIFICATION_APP_ID,
    appId,
  )
    .replaceAll(NOTIFICATION_OWNER_MARKER, owner)
    .replaceAll("ABot Notifications.lnk", shortcut)
    // Isolate the former escaped-template bug instead of touching its installed key.
    .replaceAll("${NOTIFICATION_APP_ID}", mistakenAppId);
  function cleanup() {
    const result = runWindowsScript(String.raw`
$ErrorActionPreference = 'Stop'
$Owner = '${owner}'
foreach ($AppId in @('${appId}', '${mistakenAppId}')) {
  $Path = Join-Path 'HKCU:\Software\Classes\AppUserModelId' $AppId
  if (!(Test-Path -LiteralPath $Path)) { continue }
  $Record = Get-ItemProperty -LiteralPath $Path
  $IsOwnedTestRegistration = @($Record.ABotOwner, $Record.ABotTestOwner) -contains $Owner
  if (!$IsOwnedTestRegistration) { throw 'test_registration_owner_changed' }
  Remove-Item -LiteralPath $Path
}
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) '${shortcut}'
if (Test-Path -LiteralPath $ShortcutPath) {
  $Link = (New-Object -ComObject WScript.Shell).CreateShortcut($ShortcutPath)
  if ($Link.Description -ne $Owner) { throw 'test_shortcut_owner_changed' }
  Remove-Item -LiteralPath $ShortcutPath
}
`);
    expect(result.status, result.stderr).toBe(0);
  }
  return { appId, mistakenAppId, owner, script, cleanup };
}

async function sendingScript(
  appId: string,
  rejectSubmission = false,
): Promise<string> {
  let script = "";
  await sendWindowsNotification(
    {
      target: "windows",
      notificationId: "a".repeat(64),
      title: "Test",
      body: "Test",
      url: "http://localhost:5199/chat",
    },
    undefined,
    async (input) => {
      script = Buffer.from(input.args.at(-1)!, "base64").toString("utf16le");
      return "";
    },
  );
  // Exercise all native construction but never submit a desktop notification.
  expect(script).toContain("$Notifier.Show($Toast)");
  const constructOnly = script
    .replaceAll(NOTIFICATION_APP_ID, appId)
    .replace(
      "$Notifier.Show($Toast)",
      rejectSubmission
        ? `throw [System.InvalidOperationException]::new('${localizedError}')`
        : "[pscustomobject]@{ Xml = $Toast.Content.GetXml(); Expires = ($null -ne $Toast.ExpirationTime) } | ConvertTo-Json -Compress",
    );
  expect(constructOnly).not.toContain("$Notifier.Show");
  return constructOnly;
}

test.runIf(Boolean(windowsPowerShell))(
  "Windows identity registers the expected AUMID and permits native Toast construction without sending",
  async () => {
    const identity = isolatedIdentity();
    try {
      const install = runWindowsScript(identity.script, {
        action: "install",
        url: "http://localhost:5199/notifications",
      });
      expect(install.status, install.stderr).toBe(0);
      const registration = runWindowsScript(String.raw`
$ErrorActionPreference = 'Stop'
$Path = Join-Path 'HKCU:\Software\Classes\AppUserModelId' '${identity.appId}'
$Registration = Get-ItemProperty -LiteralPath $Path
[pscustomobject]@{ Owner = $Registration.ABotOwner; DisplayName = $Registration.DisplayName } | ConvertTo-Json -Compress
`);
      expect(registration.status, registration.stderr).toBe(0);
      expect(JSON.parse(registration.stdout)).toEqual({
        Owner: identity.owner,
        DisplayName: "ABot",
      });
      const construct = runWindowsScript(await sendingScript(identity.appId), {
        title: "שלום & <result>",
        body: "A reply with 'quotes'",
        url: "http://localhost:5199/chat?environment=dev&session=one",
      });
      expect(construct.status, construct.stderr).toBe(0);
      expect(construct.stderr).toBe("");
      const result = JSON.parse(construct.stdout);
      expect(result.Expires).toBe(true);
      expect(result.Xml).toContain("שלום &amp; &lt;result&gt;");
      expect(result.Xml).toContain('activationType="protocol"');
    } finally {
      identity.cleanup();
    }
  },
  60_000,
);

test.runIf(Boolean(windowsPowerShell))(
  "Windows native submission failures preserve localized plain errors without CLIXML",
  async () => {
    const script = await sendingScript(
      "com.abot.notification-test." + randomUUID(),
      true,
    );
    const result = runWindowsScript(script, {
      title: "Test",
      body: "Test",
      url: "http://localhost:5199/chat",
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(localizedError);
    expect(result.stdout).toBe("");
  },
  20_000,
);

test.runIf(Boolean(windowsPowerShell))(
  "Windows identity preserves localized ownership errors and the existing registration",
  async () => {
    const identity = isolatedIdentity();
    try {
      const payload = {
        action: "install",
        url: "http://localhost:5199/notifications",
      };
      const install = runWindowsScript(identity.script, payload);
      expect(install.status, install.stderr).toBe(0);
      const result = runWindowsScript(
        identity.script
          .replaceAll(identity.owner, identity.owner + " other")
          .replaceAll("notification_registration_not_owned", localizedError),
        payload,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(localizedError);
    } finally {
      identity.cleanup();
    }
  },
  60_000,
);

test.runIf(Boolean(windowsPowerShell)).each([
  ["install", "owned"],
  ["uninstall", "owned"],
  ["install", "foreign"],
  ["uninstall", "foreign"],
  ["install", "missing"],
  ["uninstall", "missing"],
] as const)(
  "Windows %s cleans up only its owned legacy registration with %s marker",
  (action, ownership) => {
    const identity = isolatedIdentity();
    try {
      const payload = {
        action: "install",
        url: "http://localhost:5199/notifications",
      };
      const install = runWindowsScript(identity.script, payload);
      expect(install.status, install.stderr).toBe(0);
      const legacyOwner =
        ownership === "owned" ? identity.owner : "Another test owner";
      const seed = runWindowsScript(String.raw`
$ErrorActionPreference = 'Stop'
$LegacyPath = Join-Path 'HKCU:\Software\Classes\AppUserModelId' '${identity.mistakenAppId}'
New-Item -Path $LegacyPath -Force | Out-Null
New-ItemProperty -LiteralPath $LegacyPath -Name 'ABotTestOwner' -Value '${identity.owner}' -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $LegacyPath -Name 'Sentinel' -Value 'preserve legacy data' -PropertyType String -Force | Out-Null
${ownership === "missing" ? "" : `New-ItemProperty -LiteralPath $LegacyPath -Name 'ABotOwner' -Value '${legacyOwner}' -PropertyType String -Force | Out-Null`}
`);
      expect(seed.status, seed.stderr).toBe(0);
      const result = runWindowsScript(identity.script, { ...payload, action });
      expect(result.status, result.stderr).toBe(0);
      const inspect = runWindowsScript(String.raw`
$ErrorActionPreference = 'Stop'
$CurrentPath = Join-Path 'HKCU:\Software\Classes\AppUserModelId' '${identity.appId}'
$LegacyPath = Join-Path 'HKCU:\Software\Classes\AppUserModelId' '${identity.mistakenAppId}'
$Legacy = $null
if (Test-Path -LiteralPath $LegacyPath) {
  $Record = Get-ItemProperty -LiteralPath $LegacyPath
  $Legacy = @{ Owner = [string]$Record.ABotOwner; TestOwner = $Record.ABotTestOwner; Sentinel = $Record.Sentinel }
}
@{ CurrentExists = (Test-Path -LiteralPath $CurrentPath); Legacy = $Legacy } | ConvertTo-Json -Depth 3 -Compress
`);
      expect(inspect.status, inspect.stderr).toBe(0);
      expect(JSON.parse(inspect.stdout)).toEqual({
        CurrentExists: action === "install",
        Legacy:
          ownership === "owned"
            ? null
            : {
                Owner: ownership === "missing" ? "" : legacyOwner,
                TestOwner: identity.owner,
                Sentinel: "preserve legacy data",
              },
      });
    } finally {
      identity.cleanup();
    }
  },
  20_000,
);
