import { isHostRecord, type HostIdentity } from "./protocol.js";

export const DESKTOP_NOTIFICATION_CAPABILITY = "desktop_notifications_v1";
export { DESKTOP_NOTIFICATION_OPERATION } from "./protocol.js";
export const DESKTOP_NOTIFICATION_PATHS = [
  "/chat",
  "/notifications",
  "/home",
  "/learning",
] as const;

export type DesktopNotification = Readonly<{
  target: HostIdentity["os"];
  notificationId: string;
  title: string;
  body: string;
  url: string;
}>;

export function notificationRuntimeOrigin(runtimeUrl: string): string {
  const url = new URL(runtimeUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("notification_runtime_invalid");
  return url.origin;
}

export function resolveNotificationSourceUrl(
  value: unknown,
  runtimeUrl: string,
): string {
  if (typeof value !== "string") throw new Error("notification_url_invalid");
  if (value.length > 4096) throw new Error("notification_url_invalid");
  if (/[\\\u0000-\u0020\u007f]/u.test(value))
    throw new Error("notification_url_invalid");
  if (value.startsWith("//")) throw new Error("notification_url_invalid");
  const origin = notificationRuntimeOrigin(runtimeUrl);
  const url = new URL(value, origin);
  if (url.origin !== origin)
    throw new Error("notification_url_origin_mismatch");
  if (url.username || url.password || url.hash)
    throw new Error("notification_url_invalid");
  if (!DESKTOP_NOTIFICATION_PATHS.some((path) => path === url.pathname))
    throw new Error("notification_url_path_invalid");
  if (
    [...url.searchParams.keys()].some(
      (key) => !["environment", "session"].includes(key),
    )
  )
    throw new Error("notification_url_query_invalid");
  return url.toString();
}

export function isNotificationIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isNotificationText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && !value.trim()) return false;
  if (value.length > maximum) return false;
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

export function readDesktopNotification(
  value: unknown,
  platform: HostIdentity["os"],
  runtimeUrl: string,
): DesktopNotification {
  if (!isHostRecord(value)) throw new Error("notification_input_invalid");
  if (
    Object.keys(value).some(
      (key) =>
        !["target", "notificationId", "title", "body", "url"].includes(key),
    )
  )
    throw new Error("notification_input_invalid");
  if (value.target !== platform)
    throw new Error("notification_target_mismatch");
  if (!isNotificationIdentifier(value.notificationId))
    throw new Error("notification_id_invalid");
  if (!isNotificationText(value.title, 160))
    throw new Error("notification_title_invalid");
  if (!isNotificationText(value.body, 1000, true))
    throw new Error("notification_body_invalid");
  return {
    target: platform,
    notificationId: value.notificationId,
    title: value.title,
    body: value.body,
    url: resolveNotificationSourceUrl(value.url, runtimeUrl),
  };
}
