import type { PassiveCollectorEvent } from "../../shared/passive-observation.js";
import { isHostIdentifier, isHostRecord } from "./protocol.js";

export const OBSERVATION_CAPABILITY = "passive-observations-v1";
export const OBSERVATION_LEASE_MS = 15_000;
export const OBSERVATION_RENEW_MS = 5_000;
export const OBSERVATION_CONTENT_LIMIT = 24_000;
export const OBSERVATION_WIRE_LIMIT = 64 * 1024;

export type ObservationControl = Readonly<{
  type: "observe_start" | "observe_renew" | "observe_stop";
  leaseId: string;
  ownerId: string;
  excludedApplications?: readonly string[];
}>;

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}
export function isObservationOwner(value: unknown): value is string {
  if (!isBoundedText(value, 128)) return false;
  return value.length > 0 && !/[\x00-\x1f]/u.test(value);
}
export function isApplicationExclusionList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 128) return false;
  return value.every((item) => isObservationOwner(item));
}
export function isObservationControl(
  value: unknown,
): value is ObservationControl {
  if (!isHostRecord(value)) return false;
  if (
    !["observe_start", "observe_renew", "observe_stop"].includes(
      String(value.type),
    )
  )
    return false;
  if (!isHostIdentifier(value.leaseId)) return false;
  if (!isObservationOwner(value.ownerId)) return false;
  if (value.excludedApplications === undefined) return true;
  return isApplicationExclusionList(value.excludedApplications);
}

const STATES = [
  "starting",
  "collecting",
  "partial",
  "unavailable",
  "permission_required",
  "paused",
  "stopped",
  "disconnected",
  "failed",
];
export function isPassiveCollectorEvent(
  value: unknown,
): value is PassiveCollectorEvent {
  if (!isHostRecord(value)) return false;
  if (value.type === "status") {
    if (!STATES.includes(String(value.state))) return false;
    return value.reason === undefined || isBoundedText(value.reason, 512);
  }
  if (value.type !== "observation") return false;
  const observation = value.observation;
  if (!isHostRecord(observation)) return false;
  if (!isHostIdentifier(observation.id)) return false;
  if (
    observation.revisitsObservationId !== undefined &&
    !isHostIdentifier(observation.revisitsObservationId)
  )
    return false;
  if (!isBoundedText(observation.timestamp, 40)) return false;
  if (!Number.isFinite(Date.parse(observation.timestamp))) return false;
  if (
    !Number.isSafeInteger(observation.sequence) ||
    Number(observation.sequence) < 1
  )
    return false;
  if (!isBoundedText(observation.content, OBSERVATION_CONTENT_LIMIT))
    return false;
  if (!["view", "edit", "activity"].includes(String(observation.kind)))
    return false;
  if (!["uia", "ax", "atspi"].includes(String(observation.extraction)))
    return false;
  if (
    !["complete", "partial", "metadata_only"].includes(
      String(observation.coverage),
    )
  )
    return false;
  if (
    observation.coverageReason !== undefined &&
    !isBoundedText(observation.coverageReason, 512)
  )
    return false;
  const source = observation.source;
  if (!isHostRecord(source)) return false;
  if (!isObservationOwner(source.app)) return false;
  if (!isBoundedText(source.windowId, 256) || !source.windowId) return false;
  if (
    source.processId !== undefined &&
    (!Number.isSafeInteger(source.processId) || Number(source.processId) < 0)
  )
    return false;
  for (const key of ["documentId", "title", "url"]) {
    if (source[key] !== undefined && !isBoundedText(source[key], 4096))
      return false;
  }
  return true;
}
