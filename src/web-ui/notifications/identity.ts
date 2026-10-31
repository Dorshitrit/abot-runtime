import { createHash } from "node:crypto";
import type { NotificationKind } from "./contracts.js";

function identity(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function notificationIdentity(environmentId: string, kind: NotificationKind, key: string): string {
  return identity([environmentId, kind, key]);
}

export function approvalNotificationKey(requestId: string, approvalId: string): string {
  return identity([requestId, approvalId]);
}

export function automationNotificationIdentity(
  environmentId: string, runId: string, phase: "started" | "finished",
): string {
  return identity([environmentId, "automation", runId, phase]);
}
