import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const executeFile = promisify(execFile);
const LABEL = "com.abot.host-companion";
const OWNER_MARKER = "ABot managed native host companion";
export type NativeAutostartOptions = Readonly<{
  platform: NodeJS.Platform;
  homeDir: string;
  appData?: string;
  xdgConfigHome?: string;
  uid?: number;
  nodePath: string;
  cliPath: string;
  stateDir: string;
  execute?: (file: string, args: readonly string[]) => Promise<void>;
}>;

function xmlText(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}
function windowsArgument(value: string): string {
  if (/["\r\n\0]/u.test(value))
    throw new Error("Unsupported native startup path.");
  return `"${value}"`;
}
function vbsString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function linuxConfigHome(options: NativeAutostartOptions): string {
  if (!options.xdgConfigHome) return join(options.homeDir, ".config");
  if (!posix.isAbsolute(options.xdgConfigHome))
    return join(options.homeDir, ".config");
  return options.xdgConfigHome;
}

export function nativeAutostartFile(options: NativeAutostartOptions): string {
  if (options.platform === "linux")
    return join(linuxConfigHome(options), "autostart", `${LABEL}.desktop`);
  if (options.platform === "darwin")
    return join(options.homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
  if (options.platform !== "win32")
    throw new Error("Automatic host startup supports Windows and macOS only.");
  if (!options.appData)
    throw new Error("Windows APPDATA is unavailable for current-user startup.");
  return join(
    options.appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "ABot Host Companion.vbs",
  );
}

export function renderNativeAutostart(options: NativeAutostartOptions): string {
  if (options.platform === "linux") {
    const quote = (value: string) => {
      if (/[\r\n\0]/u.test(value))
        throw new Error("Unsupported native startup path.");
      return `"${value.replaceAll("\\", "\\\\\\\\").replaceAll('"', '\\\\"').replaceAll("`", "\\\\`").replaceAll("$", "\\\\$").replaceAll("%", "%%")}"`;
    };
    return `[Desktop Entry]\n# ${OWNER_MARKER}\nType=Application\nName=ABot Host Companion\nExec=${quote(options.nodePath)} ${quote(options.cliPath)} host run\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
  }
  if (options.platform === "win32") {
    const command = `${windowsArgument(options.nodePath)} ${windowsArgument(options.cliPath)} host run`;
    return [
      `' ${OWNER_MARKER}`,
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run ${vbsString(command)}, 0, False`,
      "",
    ].join("\r\n");
  }
  if (options.platform !== "darwin")
    throw new Error("Automatic host startup supports Windows and macOS only.");
  const argumentsXml = [options.nodePath, options.cliPath, "host", "run"]
    .map((argument) => `<string>${xmlText(argument)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${OWNER_MARKER} -->\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Interactive</string>
<key>WorkingDirectory</key><string>${xmlText(options.homeDir)}</string>
<key>StandardOutPath</key><string>${xmlText(join(options.stateDir, "agent.log"))}</string>
<key>StandardErrorPath</key><string>${xmlText(join(options.stateDir, "agent.log"))}</string>
</dict></plist>\n`;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}
export async function existingOwnedRegistration(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384)
    throw new Error(
      "Refusing to change an unexpected host startup registration.",
    );
  if (!(await readFile(path, "utf8")).includes(OWNER_MARKER))
    throw new Error("The host startup path belongs to an unmanaged file.");
  return true;
}
async function execute(
  options: NativeAutostartOptions,
  file: string,
  args: readonly string[],
): Promise<void> {
  if (options.execute) return options.execute(file, args);
  await executeFile(file, [...args], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 16_384,
  });
}
function macUserDomain(options: NativeAutostartOptions): string {
  if (!Number.isInteger(options.uid))
    throw new Error("The macOS GUI user identity is unavailable.");
  return `gui/${options.uid}`;
}
async function unloadMacRegistration(
  options: NativeAutostartOptions,
): Promise<void> {
  try {
    await execute(options, "/bin/launchctl", [
      "bootout",
      `${macUserDomain(options)}/${LABEL}`,
    ]);
  } catch (error) {
    if ([3, 113].includes(Number(errorCode(error)))) return;
    throw error;
  }
}

export async function installNativeAutostart(
  options: NativeAutostartOptions,
): Promise<{ started: boolean }> {
  const path = nativeAutostartFile(options);
  const existing = await existingOwnedRegistration(path);
  if (existing && options.platform === "darwin")
    await unloadMacRegistration(options);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, renderNativeAutostart(options), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
  if (options.platform === "darwin") {
    await execute(options, "/bin/launchctl", [
      "bootstrap",
      macUserDomain(options),
      path,
    ]);
    return { started: true };
  }
  return { started: false };
}

export async function uninstallNativeAutostart(
  options: NativeAutostartOptions,
): Promise<void> {
  const path = nativeAutostartFile(options);
  if (!(await existingOwnedRegistration(path))) return;
  await unlink(path);
  if (options.platform === "darwin") await unloadMacRegistration(options);
}
