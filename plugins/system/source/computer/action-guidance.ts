import type { SystemTargetId } from "../../../../src/plugin-sdk/computer-access.js";
import {
  routeTargetId,
  type SystemTargetSnapshot,
} from "../request-target-snapshot.js";

/** These native adapter constraints also apply to their Companion routes. */
export function wholeNotchScrollTargets(
  routes: SystemTargetSnapshot,
): readonly SystemTargetId[] {
  return Object.freeze([...new Set(routes.map(routeTargetId))].filter(
    requiresWholeNotchScroll,
  ));
}

export function computerActionGuidance(
  operationId: string,
  routes: SystemTargetSnapshot,
): string {
  if (operationId !== "computer_scroll") return "";
  const targets = wholeNotchScrollTargets(routes);
  if (targets.length === 0) return "";
  return ` On ${targets.join("/")}, both scroll deltas must be multiples of 120 wheel units.`;
}

function requiresWholeNotchScroll(target: SystemTargetId): boolean {
  if (target === "linux") return true;
  return target === "macos";
}
