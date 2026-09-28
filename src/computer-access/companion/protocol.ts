import type { ToolImplementationOutput } from "../../plugin-sdk/index.js";
import type { ObservationControl } from "./observation-protocol.js";
import type { PassiveCollectorEvent } from "../../shared/passive-observation.js";
import type { companionReleaseStatus } from "./release-version.js";

export const DESKTOP_NOTIFICATION_OPERATION = "desktop_notification";
export const HOST_PROTOCOL_VERSION = 1;
export const HOST_SOCKET_PATH = "/system-host/connect";
export const HOST_WIRE_MAX_BYTES = 256 * 1024;
export const HOST_OPERATIONS = [
  "system_targets",
  "system_command",
  "system_applications",
  "system_launch",
] as const;
export const COMPUTER_HOST_OPERATIONS = [
  "computer_execute",
  "computer_frame",
  "computer_close",
] as const;
export type HostOperation =
  | (typeof HOST_OPERATIONS)[number]
  | (typeof COMPUTER_HOST_OPERATIONS)[number]
  | typeof DESKTOP_NOTIFICATION_OPERATION;
export type HostIdentity = Readonly<{
  name: string;
  os: "windows" | "macos" | "linux";
  user: string;
  homeDir: string;
}>;
export type HostStatus = Readonly<
  {
    paired: boolean;
    hostId?: string;
    identity?: HostIdentity;
    companion?: ReturnType<typeof companionReleaseStatus>;
    capabilities?: readonly string[];
  } & (
    | { connected: true; connectionId: string }
    | { connected: false; connectionId?: never }
  )
>;
export type HostAgentHello = Readonly<{
  type: "hello";
  version: 1;
  identity: HostIdentity;
  hostId?: string;
  capabilities?: readonly string[];
  companionVersion?: number;
}>;
export type HostAgentMessage =
  | HostAgentHello
  | Readonly<{
      type: "observation_event";
      ownerId: string;
      leaseId: string;
      event: PassiveCollectorEvent;
    }>
  | Readonly<{
      type: "result";
      id: string;
      result: ToolImplementationOutput;
    }>;
export type HostServerMessage =
  | ObservationControl
  | Readonly<{
      type: "paired";
      hostId: string;
      credential: string;
    }>
  | Readonly<{ type: "ready"; hostId: string }>
  | Readonly<{
      type: "execute";
      id: string;
      hostId: string;
      operation: HostOperation;
      params: Record<string, unknown>;
    }>
  | Readonly<{ type: "cancel"; id: string }>;

export function isHostOperation(value: unknown): value is HostOperation {
  return HOST_OPERATIONS.some((operation) => operation === value);
}
export function isHostWireOperation(value: unknown): value is HostOperation {
  if (isHostOperation(value)) return true;
  if (value === DESKTOP_NOTIFICATION_OPERATION) return true;
  return COMPUTER_HOST_OPERATIONS.some((operation) => operation === value);
}
export function isHostRecord(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}
export function isHostIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}
function isHostIdentityText(value: unknown, maximum: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > maximum) return false;
  return !/[\x00-\x1f\x7f]/u.test(value);
}
export function isHostIdentity(value: unknown): value is HostIdentity {
  if (!isHostRecord(value)) return false;
  if (
    Object.keys(value).some(
      (key) => !["name", "os", "user", "homeDir"].includes(key),
    )
  )
    return false;
  if (!["windows", "macos", "linux"].includes(String(value.os))) return false;
  if (!isHostIdentityText(value.name, 128)) return false;
  if (!isHostIdentityText(value.user, 128)) return false;
  return isHostIdentityText(value.homeDir, 4096);
}
export function hasMatchingHostIdentity(
  a: HostIdentity,
  b: HostIdentity,
): boolean {
  if (a.name !== b.name) return false;
  if (a.os !== b.os) return false;
  if (a.user !== b.user) return false;
  return a.homeDir === b.homeDir;
}
export function isHostToolResult(
  value: unknown,
): value is ToolImplementationOutput {
  if (!isHostRecord(value)) return false;
  if (typeof value.ok !== "boolean") return false;
  if (typeof value.producedNewInformation !== "boolean") return false;
  if (value.data !== undefined && !isHostRecord(value.data)) return false;
  return typeof value.output === "string";
}
