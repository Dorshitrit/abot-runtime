import { hasLinuxNotificationActions } from "./notification-linux.js";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostIdentity } from "./protocol.js";
import {
  hasOwnedNotificationDirectory,
  linuxNotificationDesktopPath,
} from "./notification-installation.js";
import {
  macNotificationAppPath,
  notificationInstallDirectory,
  type NotificationLocations,
} from "./notification-locations.js";
import {
  runNotificationProcess,
  type NotificationProcessRunner,
} from "./notification-process.js";

export async function hasDesktopNotificationSupport(
  platform: HostIdentity["os"],
  locations: NotificationLocations,
  run: NotificationProcessRunner = runNotificationProcess,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    if (!(await hasOwnedNotificationDirectory(locations))) return false;
    const ready = await readFile(
      join(notificationInstallDirectory(locations), ".ready"),
      "utf8",
    );
    const expected = { windows: "win32", macos: "darwin", linux: "linux" }[
      platform
    ];
    if (ready !== expected) return false;
    if (platform === "windows") return true;
    if (platform === "macos") {
      await access(
        join(macNotificationAppPath(locations), "Contents", "MacOS", "applet"),
      );
      return true;
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    await access(linuxNotificationDesktopPath(locations));
    signal?.throwIfAborted();
    const help = await run({ file: "notify-send", args: ["--help"], signal });
    signal?.throwIfAborted();
    if (
      !["--wait", "--action", "--print-id"].every((option) =>
        help.includes(option),
      )
    )
      return false;
    return await hasLinuxNotificationActions(run, signal);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
