import { isHostRecord } from "./protocol.js";

export const MACOS_PERMISSION_CAPABILITY = "macos_permission_preflight_v1";
export { MACOS_PERMISSION_OPERATION } from "./protocol.js";
export type MacPermission = "screen_recording" | "accessibility";
export type MacPermissionAction =
  | Readonly<{ action: "check" }>
  | Readonly<{ action: "request"; permission: MacPermission }>;
export type MacPermissionStatus = Readonly<{
  screenRecording: "granted" | "required";
  accessibility: "granted" | "required";
}>;
export type MacPermissionResult = Readonly<{
  permissions: MacPermissionStatus;
  executablePath: string;
  restartMayBeRequired: boolean;
}>;

export function isMacPermissionAction(value: unknown): value is MacPermissionAction {
  if (!isHostRecord(value)) return false;
  if (Object.keys(value).some((key) => !["action", "permission"].includes(key)))
    return false;
  if (value.action === "check") return !Object.hasOwn(value, "permission");
  if (value.action !== "request") return false;
  return value.permission === "screen_recording" || value.permission === "accessibility";
}

export function isMacPermissionStatus(value: unknown): value is MacPermissionStatus {
  if (!isHostRecord(value)) return false;
  if (Object.keys(value).some((key) => !["screenRecording", "accessibility"].includes(key)))
    return false;
  if (value.screenRecording !== "granted" && value.screenRecording !== "required") return false;
  return value.accessibility === "granted" || value.accessibility === "required";
}

/** The browser receives only permission state and the current permission subject. */
export function readMacPermissionResult(value: unknown): MacPermissionResult | undefined {
  if (!isHostRecord(value)) return undefined;
  if (!isMacPermissionStatus(value.permissions)) return undefined;
  if (typeof value.executablePath !== "string") return undefined;
  if (!value.executablePath.startsWith("/")) return undefined;
  if (value.executablePath.length > 4096) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(value.executablePath)) return undefined;
  if (typeof value.restartMayBeRequired !== "boolean") return undefined;
  return {
    permissions: value.permissions,
    executablePath: value.executablePath,
    restartMayBeRequired: value.restartMayBeRequired,
  };
}
