import type { DesktopNotification } from "./notification-protocol.js";
import {
  NOTIFICATION_APP_ID,
  NOTIFICATION_OWNER_MARKER,
  NOTIFICATION_WINDOWS_CLSID,
} from "./notification-locations.js";
import {
  runNotificationProcess,
  type NotificationProcessRunner,
} from "./notification-process.js";

const LEGACY_NOTIFICATION_APP_ID = "${NOTIFICATION_APP_ID}";

const WINDOWS_NOTIFICATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$Payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$Notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${NOTIFICATION_APP_ID}')
# Win32 Setting is unavailable until the first toast; Show honors Windows notification settings.
$Xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$Xml.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text/><text/></binding></visual><audio silent="true"/></toast>')
$Xml.DocumentElement.SetAttribute('launch', [string]$Payload.url)
$Texts = $Xml.GetElementsByTagName('text')
$Texts.Item(0).AppendChild($Xml.CreateTextNode([string]$Payload.title)) | Out-Null
$Texts.Item(1).AppendChild($Xml.CreateTextNode([string]$Payload.body)) | Out-Null
$Toast = [Windows.UI.Notifications.ToastNotification]::new($Xml)
$Toast.ExpirationTime = [DateTimeOffset]::Now.AddDays(1)
$Notifier.Show($Toast)
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
`;

export const WINDOWS_NOTIFICATION_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Remove-OwnedLegacyNotificationIdentity {
  $LegacyRegistryPath = Join-Path 'HKCU:\Software\Classes\AppUserModelId' '${LEGACY_NOTIFICATION_APP_ID}'
  if (!(Test-Path -LiteralPath $LegacyRegistryPath)) { return }
  $LegacyRegistration = Get-ItemProperty -LiteralPath $LegacyRegistryPath
  if ($LegacyRegistration.ABotOwner -ne '${NOTIFICATION_OWNER_MARKER}') { return }
  Remove-Item -LiteralPath $LegacyRegistryPath
}
try {
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$Payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'ABot Notifications.lnk'
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
if ((Test-Path -LiteralPath $ShortcutPath) -and $Shortcut.Description -ne '${NOTIFICATION_OWNER_MARKER}') {
  throw 'notification_registration_not_owned'
}
$RegistryPath = Join-Path 'HKCU:\Software\Classes\AppUserModelId' '${NOTIFICATION_APP_ID}'
if (Test-Path -LiteralPath $RegistryPath) {
  $Registration = Get-ItemProperty -LiteralPath $RegistryPath
  if ($Registration.ABotOwner -ne '${NOTIFICATION_OWNER_MARKER}') { throw 'notification_registration_not_owned' }
}
if ($Payload.action -eq 'uninstall') {
  if (Test-Path -LiteralPath $ShortcutPath) { Remove-Item -LiteralPath $ShortcutPath }
  if (Test-Path -LiteralPath $RegistryPath) { Remove-Item -LiteralPath $RegistryPath }
  Remove-OwnedLegacyNotificationIdentity
  exit 0
}
$Shortcut.TargetPath = Join-Path $env:WINDIR 'explorer.exe'
$Shortcut.Arguments = [string]$Payload.url
$Shortcut.Description = '${NOTIFICATION_OWNER_MARKER}'
$Shortcut.Save()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ABotShortcutIdentity {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey {
    public Guid format;
    public uint id;
    public PropertyKey(uint value) { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); id = value; }
  }
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  public struct PropertyValue {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropertyValue value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr context, uint flags, ref Guid iid, out IPropertyStore store);
  public static void Register(string path, string appId, string activator) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
    try {
      Set(store, 5, 31, Marshal.StringToCoTaskMemUni(appId));
      IntPtr guid = Marshal.AllocCoTaskMem(16);
      Marshal.StructureToPtr(new Guid(activator), guid, false);
      Set(store, 26, 72, guid);
      Marshal.ThrowExceptionForHR(store.Commit());
    } finally { Marshal.ReleaseComObject(store); }
  }
  static void Set(IPropertyStore store, uint id, ushort type, IntPtr pointer) {
    try {
      PropertyKey key = new PropertyKey(id);
      PropertyValue value = new PropertyValue { type = type, pointer = pointer };
      Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
    } finally { Marshal.FreeCoTaskMem(pointer); }
  }
}
'@
[ABotShortcutIdentity]::Register($ShortcutPath, '${NOTIFICATION_APP_ID}', '${NOTIFICATION_WINDOWS_CLSID}')
New-Item -Path $RegistryPath -Force | Out-Null
New-ItemProperty -LiteralPath $RegistryPath -Name 'DisplayName' -Value 'ABot' -PropertyType ExpandString -Force | Out-Null
New-ItemProperty -LiteralPath $RegistryPath -Name 'ABotOwner' -Value '${NOTIFICATION_OWNER_MARKER}' -PropertyType String -Force | Out-Null
Remove-OwnedLegacyNotificationIdentity
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
`;

export function powershellNotificationArguments(script: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

export async function sendWindowsNotification(
  notification: DesktopNotification,
  signal?: AbortSignal,
  run: NotificationProcessRunner = runNotificationProcess,
): Promise<void> {
  await run({
    file: "powershell.exe",
    args: powershellNotificationArguments(WINDOWS_NOTIFICATION_SCRIPT),
    input: JSON.stringify(notification),
    signal,
  });
}
