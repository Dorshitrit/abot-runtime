import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { join } from "node:path";
import { NOTIFICATION_APP_ID } from "./notification-locations.js";
import type { NotificationProcessRunner } from "./notification-process.js";

/** Foundation retains compiler-owned plist values and their native types. */
const MAC_NOTIFICATION_PLIST_SCRIPT = String.raw`
ObjC.import('Foundation');
function run(argv) {
  var plist = $.NSMutableDictionary.alloc.initWithContentsOfFile($(argv[0]));
  if (!plist) throw new Error('notification_bundle_plist_invalid');
  if (argv[1]) {
    var updates = JSON.parse(argv[1]);
    Object.keys(updates).forEach(function(key) {
      plist.setObjectForKey($(updates[key]), $(key));
    });
    if (!plist.writeToFileAtomically($(argv[0]), true))
      throw new Error('notification_bundle_plist_write_failed');
  }
  return JSON.stringify({
    executable: ObjC.unwrap(plist.objectForKey('CFBundleExecutable')),
    identifier: ObjC.unwrap(plist.objectForKey('CFBundleIdentifier'))
  });
}
`;

function isBundleExecutableName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value === "." || value === "..") return false;
  return !/[\\/\u0000-\u001f\u007f]/.test(value);
}

async function assertBundleDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("notification_bundle_directory_invalid");
}

async function assertBundleFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("notification_bundle_file_invalid");
}

async function readBundleMetadata(
  app: string,
  run: NotificationProcessRunner,
  signal?: AbortSignal,
): Promise<{ executable: unknown; identifier: unknown }> {
  await assertBundleDirectory(app);
  await assertBundleDirectory(join(app, "Contents"));
  await assertBundleDirectory(join(app, "Contents", "MacOS"));
  const plist = join(app, "Contents", "Info.plist");
  await assertBundleFile(plist);
  return JSON.parse(await run({
    file: "/usr/bin/osascript",
    args: ["-l", "JavaScript", "-e", MAC_NOTIFICATION_PLIST_SCRIPT, plist],
    signal,
  }));
}

async function assertBundleExecutable(app: string, executable: unknown): Promise<void> {
  if (!isBundleExecutableName(executable))
    throw new Error("notification_bundle_executable_invalid");
  const path = join(app, "Contents", "MacOS", executable);
  await assertBundleFile(path);
  await access(path, constants.X_OK);
}

export async function assertMacNotificationBundle(
  app: string,
  run: NotificationProcessRunner,
  signal?: AbortSignal,
): Promise<void> {
  const metadata = await readBundleMetadata(app, run, signal);
  if (metadata.identifier !== NOTIFICATION_APP_ID)
    throw new Error("notification_bundle_identity_invalid");
  await assertBundleExecutable(app, metadata.executable);
}

export async function configureMacNotificationBundle(
  app: string,
  run: NotificationProcessRunner,
): Promise<void> {
  const metadata = await readBundleMetadata(app, run);
  await assertBundleExecutable(app, metadata.executable);
  await run({
    file: "/usr/bin/osascript",
    args: ["-l", "JavaScript", "-e", MAC_NOTIFICATION_PLIST_SCRIPT,
      join(app, "Contents", "Info.plist"), JSON.stringify({
        CFBundleIdentifier: NOTIFICATION_APP_ID,
        CFBundleName: "ABot",
        CFBundleDisplayName: "ABot",
        LSUIElement: true,
        OSAAppletStayOpen: true,
        OSAAppletShowStartupScreen: false,
        NSHighResolutionCapable: true,
      })],
  });
  await assertMacNotificationBundle(app, run);
}
