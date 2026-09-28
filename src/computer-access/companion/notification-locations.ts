import { homedir } from "node:os";
import { join } from "node:path";

export const NOTIFICATION_APP_ID = "com.abot.notifications";
export const NOTIFICATION_OWNER_MARKER =
  "ABot managed desktop notifications v1";
export const NOTIFICATION_WINDOWS_CLSID =
  "{E13CEAD1-5B60-4B49-9537-54836F743F2E}";

export type NotificationLocations = Readonly<{
  stateDir: string;
  homeDir: string;
  appData?: string;
  xdgDataHome?: string;
}>;

export function defaultNotificationLocations(): NotificationLocations {
  const homeDir = homedir();
  return {
    homeDir,
    stateDir: join(homeDir, ".abot", "host-companion"),
    appData: process.env.APPDATA,
    xdgDataHome: process.env.XDG_DATA_HOME,
  };
}

export function notificationInstallDirectory(
  locations: NotificationLocations,
): string {
  return join(locations.stateDir, "notifications");
}

export function macNotificationAppPath(
  locations: NotificationLocations,
): string {
  return join(notificationInstallDirectory(locations), "ABot.app");
}
