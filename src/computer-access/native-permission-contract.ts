import { isHostIdentifier, isHostRecord } from "./companion/protocol.js";
import { isMacPermissionAction, type MacPermissionAction, type MacPermissionResult } from "./companion/permission-protocol.js";

export type NativePermissionStatus =
  | Readonly<{ available: true; ownerId: string; computerName: string; executablePath: string }>
  | Readonly<{ available: false; reason: string }>;
export type NativePermissionInput = MacPermissionAction & Readonly<{ ownerId: string }>;
export type NativePermissionResult = MacPermissionResult & Readonly<{ ownerId: string }>;
export type NativePermissionClient = Readonly<{
  status(): Promise<NativePermissionStatus>;
  prepare(input: NativePermissionInput): Promise<NativePermissionResult>;
}>;

export function readNativePermissionInput(value: unknown): NativePermissionInput | undefined {
  if (!isHostRecord(value)) return undefined;
  const { ownerId, ...action } = value;
  if (!isHostIdentifier(ownerId)) return undefined;
  if (!isMacPermissionAction(action)) return undefined;
  return { ownerId, ...action };
}

export function isNativePermissionEnvironment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.trim() || value.length > 256) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isNativePermissionStatus(value: unknown): value is NativePermissionStatus {
  if (!isHostRecord(value)) return false;
  if (value.available === false) return typeof value.reason === "string" && value.reason.length <= 256;
  if (value.available !== true) return false;
  if (!isHostIdentifier(value.ownerId)) return false;
  if (typeof value.computerName !== "string" || value.computerName.length > 256) return false;
  if (!value.computerName.trim() || /[\u0000-\u001f\u007f]/u.test(value.computerName)) return false;
  if (typeof value.executablePath !== "string" || value.executablePath.length > 4096) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value.executablePath)) return false;
  return value.executablePath.startsWith("/");
}
