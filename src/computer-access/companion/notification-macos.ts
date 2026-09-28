import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopNotification } from "./notification-protocol.js";
import {
  macNotificationAppPath,
  notificationInstallDirectory,
  type NotificationLocations,
} from "./notification-locations.js";
import {
  runNotificationProcess,
  type NotificationProcessRunner,
} from "./notification-process.js";

/**
 * Runs inside the installed ABot.app, not osascript. NSUserNotification is the
 * documented applet-compatible API; native macOS acceptance is required because
 * Apple deprecated this API in favor of UserNotifications.
 */
export function renderMacNotificationApplet(stateDir: string): string {
  return (
    "var stateDirectory = " +
    JSON.stringify(stateDir) +
    ";\n" +
    String.raw`
ObjC.import('Cocoa');
var center = $.NSUserNotificationCenter.defaultUserNotificationCenter;
function readJson(path) {
  var text = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  if (!text) throw new Error('notification_file_unavailable');
  return JSON.parse(ObjC.unwrap(text));
}
function sourceUrlAllowed(value) {
  if (typeof value !== 'string') return false;
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return false;
  var connection = readJson(stateDirectory + '/connection.json');
  var origin = connection.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  if (value.indexOf(origin + '/') !== 0) return false;
  var path = value.slice(origin.length).split('?')[0];
  return ['/chat', '/notifications', '/home', '/learning'].indexOf(path) !== -1;
}
ObjC.registerSubclass({
  name: 'ABotDesktopNotificationDelegate',
  protocols: ['NSUserNotificationCenterDelegate'],
  methods: {
    'userNotificationCenter:didActivateNotification:': {
      types: ['void', ['id', 'id']],
      implementation: function(notificationCenter, notification) {
        try {
          var data = ObjC.deepUnwrap(notification.userInfo);
          if (sourceUrlAllowed(data.url))
            $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString($(data.url)));
        } catch (_) {}
        notificationCenter.removeDeliveredNotification(notification);
      }
    },
    'userNotificationCenter:shouldPresentNotification:': {
      types: ['bool', ['id', 'id']],
      implementation: function() { return true; }
    }
  }
});
var delegate = $.ABotDesktopNotificationDelegate.alloc.init;
center.delegate = delegate;
function receipt(path, value) {
  $(JSON.stringify(value)).writeToFileAtomicallyEncodingError($(path + '.result'), true, $.NSUTF8StringEncoding, null);
}
function pendingPathAllowed(path) {
  var prefix = ObjC.unwrap($(stateDirectory + '/notifications/pending').stringByResolvingSymlinksInPath) + '/';
  var resolved = ObjC.unwrap($(path).stringByResolvingSymlinksInPath);
  if (resolved.indexOf(prefix) !== 0) return false;
  return /^[0-9a-f-]{36}\.json$/.test(resolved.slice(prefix.length));
}
function showFile(path) {
  if (!pendingPathAllowed(path)) return;
  try {
    var payload = readJson(path);
    if (payload.expiresAt < Date.now()) throw new Error('notification_expired');
    if (!/^[0-9a-f]{64}$/.test(payload.notificationId)) throw new Error('notification_id_invalid');
    if (!sourceUrlAllowed(payload.url)) throw new Error('notification_url_invalid');
    if (typeof payload.title !== 'string' || payload.title.length > 160) throw new Error('notification_title_invalid');
    if (typeof payload.body !== 'string' || payload.body.length > 1000) throw new Error('notification_body_invalid');
    var notification = $.NSUserNotification.alloc.init;
    notification.identifier = $(payload.notificationId);
    notification.title = $(payload.title);
    notification.informativeText = $(payload.body);
    notification.userInfo = $({url: payload.url});
    center.deliverNotification(notification);
    receipt(path, {ok: true});
  } catch (error) {
    receipt(path, {ok: false, error: String(error.message || error)});
  }
}
function openDocuments(documents) {
  for (var index = 0; index < documents.length; index++) showFile(String(documents[index]));
}
function run() {}
function idle() { return 30; }
`
  );
}

export async function sendMacNotification(
  notification: DesktopNotification,
  locations: NotificationLocations,
  signal?: AbortSignal,
  run: NotificationProcessRunner = runNotificationProcess,
): Promise<void> {
  const file = join(
    notificationInstallDirectory(locations),
    "pending",
    randomUUID() + ".json",
  );
  const resultFile = file + ".result";
  await writeFile(
    file,
    JSON.stringify({ ...notification, expiresAt: Date.now() + 15_000 }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    signal?.throwIfAborted();
    await run({
      file: "/usr/bin/open",
      args: ["-g", "-a", macNotificationAppPath(locations), file],
      signal,
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const receipt = await readFile(resultFile, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (receipt) {
        const result = JSON.parse(receipt) as { ok: boolean; error?: string };
        if (!result.ok)
          throw new Error(result.error || "notification_native_failed");
        return;
      }
      await delay(50, undefined, { signal });
    }
    throw new Error("notification_native_timeout");
  } finally {
    await Promise.all(
      [file, resultFile].map((path) =>
        unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }),
      ),
    );
  }
}

export const MAC_NOTIFICATION_STOP_SCRIPT = String.raw`
ObjC.import('Cocoa');
function run(args) {
  var expectedPath = ObjC.unwrap($(args[0]).stringByResolvingSymlinksInPath);
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.abot.notifications');
  for (var index = 0; index < apps.count; index++) {
    var app = apps.objectAtIndex(index);
    var runningPath = ObjC.unwrap($(ObjC.unwrap(app.bundleURL.path)).stringByResolvingSymlinksInPath);
    if (runningPath !== expectedPath) continue;
    app.terminate;
    var deadline = Date.now() + 3000;
    while (!app.terminated && Date.now() < deadline) delay(0.05);
    if (!app.terminated) throw new Error('notification_app_stop_failed');
  }
}
`;
