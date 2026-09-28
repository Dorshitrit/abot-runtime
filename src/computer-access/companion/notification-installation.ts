import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { NativeAutostartOptions } from "./autostart.js";
import {
  ensureOwnedNotificationDirectory,
  hasOwnedNotificationDirectory,
  removeOwnedNotificationDirectory,
} from "./notification-directory.js";
export { hasOwnedNotificationDirectory } from "./notification-directory.js";
import {
  MAC_NOTIFICATION_STOP_SCRIPT,
  renderMacNotificationApplet,
} from "./notification-macos.js";
import {
  NOTIFICATION_APP_ID,
  NOTIFICATION_OWNER_MARKER,
  macNotificationAppPath,
  notificationInstallDirectory,
  type NotificationLocations,
} from "./notification-locations.js";
import { notificationRuntimeOrigin } from "./notification-protocol.js";
import {
  runNotificationProcess,
  type NotificationProcessRunner,
} from "./notification-process.js";
import {
  powershellNotificationArguments,
  WINDOWS_NOTIFICATION_IDENTITY_SCRIPT,
} from "./notification-windows.js";

export function notificationLocationsFromStartup(
  startup: NativeAutostartOptions,
): NotificationLocations {
  return {
    stateDir: startup.stateDir,
    homeDir: startup.homeDir,
    appData: startup.appData,
    xdgDataHome: process.env.XDG_DATA_HOME,
  };
}

export function linuxNotificationDesktopPath(
  locations: NotificationLocations,
): string {
  const dataHome =
    locations.xdgDataHome && isAbsolute(locations.xdgDataHome)
      ? locations.xdgDataHome
      : join(locations.homeDir, ".local", "share");
  return join(dataHome, "applications", NOTIFICATION_APP_ID + ".desktop");
}

function desktopArgument(value: string): string {
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", "\\$")
      .replaceAll("\u0060", "\\\u0060") +
    '"'
  );
}

export function renderLinuxNotificationDesktop(runtimeUrl: string): string {
  const url = notificationRuntimeOrigin(runtimeUrl) + "/notifications";
  return [
    "[Desktop Entry]",
    "# " + NOTIFICATION_OWNER_MARKER,
    "Type=Application",
    "Name=ABot",
    "Comment=ABot notifications",
    "Exec=xdg-open " + desktopArgument(url),
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    "",
  ].join("\n");
}

async function assertLinuxDesktopOwnership(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("notification_registration_not_owned");
  if (
    !(await readFile(path, "utf8")).includes("# " + NOTIFICATION_OWNER_MARKER)
  )
    throw new Error("notification_registration_not_owned");
  return true;
}

function macNotificationPlist(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>' +
    "<key>CFBundleExecutable</key><string>applet</string>" +
    "<key>CFBundleIdentifier</key><string>" +
    NOTIFICATION_APP_ID +
    "</string>" +
    "<key>CFBundleName</key><string>ABot</string><key>CFBundleDisplayName</key><string>ABot</string>" +
    "<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleSignature</key><string>aplt</string>" +
    "<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string>" +
    "<key>CFBundleIconFile</key><string>applet</string><key>LSUIElement</key><true/>" +
    "<key>OSAAppletStayOpen</key><true/><key>OSAAppletShowStartupScreen</key><false/>" +
    "<key>NSHighResolutionCapable</key><true/></dict></plist>\n"
  );
}

export async function stopMacNotificationApp(
  locations: NotificationLocations,
  run: NotificationProcessRunner,
): Promise<void> {
  await run({
    file: "/usr/bin/osascript",
    args: [
      "-l",
      "JavaScript",
      "-e",
      MAC_NOTIFICATION_STOP_SCRIPT,
      macNotificationAppPath(locations),
    ],
  });
}

async function installMacNotificationApp(
  locations: NotificationLocations,
  run: NotificationProcessRunner,
): Promise<void> {
  const directory = notificationInstallDirectory(locations);
  const source = join(directory, "notification-helper.js");
  const temporary = join(directory, "ABot.next.app");
  const app = macNotificationAppPath(locations);
  await writeFile(source, renderMacNotificationApplet(locations.stateDir), {
    mode: 0o600,
  });
  await rm(temporary, { recursive: true, force: true });
  await run({
    file: "/usr/bin/osacompile",
    args: ["-l", "JavaScript", "-s", "-o", temporary, source],
    timeoutMs: 30_000,
  });
  await writeFile(
    join(temporary, "Contents", "Info.plist"),
    macNotificationPlist(),
  );
  await run({
    file: "/usr/bin/codesign",
    args: [
      "--force",
      "--sign",
      "-",
      "--identifier",
      NOTIFICATION_APP_ID,
      temporary,
    ],
    timeoutMs: 30_000,
  });
  await stopMacNotificationApp(locations, run);
  await rm(app, { recursive: true, force: true });
  await rename(temporary, app);
  await run({
    file: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    args: ["-f", app],
  });
}

export async function installDesktopNotificationIdentity(
  startup: NativeAutostartOptions,
  runtimeUrl: string,
  run: NotificationProcessRunner = runNotificationProcess,
): Promise<void> {
  const locations = notificationLocationsFromStartup(startup);
  const directory = notificationInstallDirectory(locations);
  await ensureOwnedNotificationDirectory(locations, run);
  await rm(join(directory, ".ready"), { force: true });
  await mkdir(join(directory, "pending"), { recursive: true, mode: 0o700 });
  await registerDesktopNotificationIdentity(
    startup.platform,
    locations,
    runtimeUrl,
    run,
  );
  await writeFile(join(directory, ".ready"), startup.platform, { mode: 0o600 });
}

async function registerDesktopNotificationIdentity(
  platform: NodeJS.Platform,
  locations: NotificationLocations,
  runtimeUrl: string,
  run: NotificationProcessRunner,
): Promise<void> {
  if (platform === "win32") {
    await run({
      file: "powershell.exe",
      args: powershellNotificationArguments(
        WINDOWS_NOTIFICATION_IDENTITY_SCRIPT,
      ),
      input: JSON.stringify({
        action: "install",
        url: notificationRuntimeOrigin(runtimeUrl) + "/notifications",
      }),
    });
    return;
  }
  if (platform === "darwin") return installMacNotificationApp(locations, run);
  if (platform === "linux")
    return installLinuxNotificationIdentity(locations, runtimeUrl, run);
  throw new Error("notification_platform_unsupported");
}

async function uninstallMacNotificationApp(
  locations: NotificationLocations,
  run: NotificationProcessRunner,
): Promise<void> {
  const app = macNotificationAppPath(locations);
  const stat = await lstat(app).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("notification_registration_not_owned");
  await stopMacNotificationApp(locations, run);
  await run({
    file: "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    args: ["-u", app],
  });
}

async function installLinuxNotificationIdentity(
  locations: NotificationLocations,
  runtimeUrl: string,
  run: NotificationProcessRunner,
): Promise<void> {
  const help = await run({ file: "notify-send", args: ["--help"] }).catch(
    () => {
      throw new Error(
        "Desktop notifications require notify-send from libnotify-bin on the Linux desktop.",
      );
    },
  );
  if (
    !["--wait", "--action", "--print-id"].every((option) =>
      help.includes(option),
    )
  )
    throw new Error(
      "Desktop notifications require a notify-send version with action support.",
    );
  await run({ file: "xdg-open", args: ["--version"] });
  await run({ file: "gdbus", args: ["help"] }).catch(() => {
    throw new Error(
      "Desktop notification actions require gdbus from libglib2.0-bin on the Linux desktop.",
    );
  });
  const path = linuxNotificationDesktopPath(locations);
  await assertLinuxDesktopOwnership(path);
  await mkdir(dirname(path), { recursive: true });
  const content = renderLinuxNotificationDesktop(runtimeUrl);
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content).finally(() => file.close());
    await assertLinuxDesktopOwnership(path);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function uninstallDesktopNotificationIdentity(
  startup: NativeAutostartOptions,
  run: NotificationProcessRunner = runNotificationProcess,
): Promise<void> {
  const locations = notificationLocationsFromStartup(startup);
  if (!(await hasOwnedNotificationDirectory(locations))) return;
  if (startup.platform === "win32") {
    await run({
      file: "powershell.exe",
      args: powershellNotificationArguments(
        WINDOWS_NOTIFICATION_IDENTITY_SCRIPT,
      ),
      input: JSON.stringify({ action: "uninstall" }),
    });
  }
  if (startup.platform === "darwin") {
    await uninstallMacNotificationApp(locations, run);
  }
  if (startup.platform === "linux") {
    const path = linuxNotificationDesktopPath(locations);
    if (await assertLinuxDesktopOwnership(path)) await rm(path);
  }
  await removeOwnedNotificationDirectory(locations);
}
