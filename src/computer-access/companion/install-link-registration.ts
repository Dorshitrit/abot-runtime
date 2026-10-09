import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import type { NativeAutostartOptions } from "./autostart.js";
import { ensurePrivateRuntimeDirectory } from "../../runtime/local-host/private-directory.js";
import {
  renderWindowsInstallLinkLauncher,
  windowsInstallLinkLauncherPath,
  windowsInstallLinkRegistryScript,
} from "./install-link-windows.js";
import {
  renderMacInstallLinkHandler,
  requireAvailableMacInstallScheme,
  MAC_INSTALL_LINK_PLIST_SCRIPT,
  MAC_INSTALL_LINK_BUNDLE_ID,
} from "./install-link-macos.js";

const OWNER = "ABot managed installation links";
const executeFile = promisify(execFile);

function desktopArgument(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error("Unsupported Companion path.");
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("$", "\\$")
      .replaceAll("`", "\\`")
      .replaceAll("%", "%%") +
    '"'
  );
}

export function renderLinuxInstallLinkDesktop(
  options: NativeAutostartOptions,
): string {
  return `[Desktop Entry]
# ${OWNER}
Type=Application
Name=ABot Install
Exec=${desktopArgument(options.nodePath)} ${desktopArgument(options.cliPath)} host open-link %u
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/abot;
`;
}

function registrationDirectory(options: NativeAutostartOptions): string {
  return join(options.stateDir, "install-links");
}

async function run(
  options: NativeAutostartOptions,
  file: string,
  args: readonly string[],
): Promise<void> {
  if (options.execute) return options.execute(file, args);
  await executeFile(file, [...args], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16_384,
  });
}

async function existingOwnedDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Installation-link directory is not owned.");
  if ((await readFile(join(path, ".owner"), "utf8")) !== OWNER)
    throw new Error("Installation-link directory is not owned.");
  return true;
}

function hasAbsoluteLinuxDataHome(value: string | undefined): value is string {
  if (!value) return false;
  return posix.isAbsolute(value);
}

function linuxDesktopPath(options: NativeAutostartOptions): string {
  const dataHome = process.env.XDG_DATA_HOME;
  if (hasAbsoluteLinuxDataHome(dataHome))
    return join(dataHome, "applications", "com.abot.install-links.desktop");
  return join(
    options.homeDir,
    ".local",
    "share",
    "applications",
    "com.abot.install-links.desktop",
  );
}

async function requireOwnedLinuxRegistration(path: string): Promise<void> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !(await readFile(path, "utf8")).includes("# " + OWNER)
  )
    throw new Error("Installation-link desktop registration is not owned.");
}

function isAvailableLinuxInstallScheme(handler: string): boolean {
  if (!handler) return true;
  return handler === "com.abot.install-links.desktop";
}

async function requireAvailableLinuxInstallScheme(): Promise<void> {
  const { stdout } = await executeFile(
    "xdg-mime",
    ["query", "default", "x-scheme-handler/abot"],
    { timeout: 30_000, maxBuffer: 16_384 },
  );
  if (!isAvailableLinuxInstallScheme(stdout.trim()))
    throw new Error("The abot URL scheme belongs to another application.");
}

export async function installCompanionInstallLinks(
  options: NativeAutostartOptions,
): Promise<void> {
  const directory = registrationDirectory(options);
  if (!(await existingOwnedDirectory(directory))) {
    await ensurePrivateRuntimeDirectory(directory);
    await writeFile(join(directory, ".owner"), OWNER, {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (options.platform === "win32") {
    const launcher = windowsInstallLinkLauncherPath(options);
    await writeFile(launcher, renderWindowsInstallLinkLauncher(options), {
      mode: 0o600,
    });
    await run(options, "powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        windowsInstallLinkRegistryScript("install", launcher),
        "utf16le",
      ).toString("base64"),
    ]);
    return;
  }
  if (options.platform === "linux") {
    const desktop = linuxDesktopPath(options);
    await requireOwnedLinuxRegistration(desktop);
    await requireAvailableLinuxInstallScheme();
    await mkdir(dirname(desktop), { recursive: true, mode: 0o700 });
    await writeFile(desktop, renderLinuxInstallLinkDesktop(options), {
      mode: 0o600,
    });
    await run(options, "xdg-mime", [
      "default",
      "com.abot.install-links.desktop",
      "x-scheme-handler/abot",
    ]);
    return;
  }
  if (options.platform === "darwin") {
    await requireAvailableMacInstallScheme();
    const source = join(directory, "handler.js");
    const app = join(directory, "ABot Install.app");
    await writeFile(source, renderMacInstallLinkHandler(options), {
      mode: 0o600,
    });
    await rm(app, { recursive: true, force: true });
    await run(options, "/usr/bin/osacompile", [
      "-l",
      "JavaScript",
      "-o",
      app,
      source,
    ]);
    await run(options, "/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      MAC_INSTALL_LINK_PLIST_SCRIPT,
      join(app, "Contents", "Info.plist"),
    ]);
    await run(options, "/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      MAC_INSTALL_LINK_BUNDLE_ID,
      app,
    ]);
    await run(
      options,
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", app],
    );
    return;
  }
  throw new Error("Installation links are not supported on this platform.");
}

export async function uninstallCompanionInstallLinks(
  options: NativeAutostartOptions,
): Promise<void> {
  const directory = registrationDirectory(options);
  if (!(await existingOwnedDirectory(directory))) return;
  if (options.platform === "win32")
    await run(options, "powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        windowsInstallLinkRegistryScript(
          "remove",
          windowsInstallLinkLauncherPath(options),
        ),
        "utf16le",
      ).toString("base64"),
    ]);
  if (options.platform === "linux") {
    const desktop = linuxDesktopPath(options);
    await requireOwnedLinuxRegistration(desktop);
    await rm(desktop, { force: true });
  }
  if (options.platform === "darwin")
    await run(
      options,
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-u", join(directory, "ABot Install.app")],
    );
  await rm(directory, { recursive: true });
}
