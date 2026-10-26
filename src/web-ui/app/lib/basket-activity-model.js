import { basketStatusLabel } from "./tool-basket-activity-fields.js";
import { projectRoleDelegationEvent } from "./role-delegation-event.js";

const BASKET_ACTIVITY_STATUSES = Object.freeze({
  discovery_found: "matched",
  search_started: "started",
  search_completed: "completed",
  search_unavailable: "unavailable",
  read_started: "started",
  read_completed: "completed",
  read_unavailable: "unavailable",
});

function isToolLifecycleEvent(event) {
  const name = event?.eventName || event?.name || event?.rawType || event?.type;
  return typeof name === "string" && name.startsWith("tool.");
}

/** Status phases survive both raw events and the live/replay display projection. */
export function isBasketStatusEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (isToolLifecycleEvent(event)) return false;
  if (event.stage !== "information_basket") return false;
  if (typeof event.phase !== "string") return false;
  return Object.hasOwn(BASKET_ACTIVITY_STATUSES, event.phase);
}

function isSupervisorBasketRequestEvidence(event) {
  if (isToolLifecycleEvent(event)) return false;
  if (projectRoleDelegationEvent(event)) return true;
  // Generic supervisor stages also occur in EA; only root Skill reads establish SUPER.
  if (event?.stage === "supervisor") return event.phase === "skills";
  if (!isBasketStatusEvent(event)) return false;
  return event.phase !== "discovery_found";
}

/** Call with ordered, request-scoped events; discovery alone does not establish SUPER ownership. */
export function hasSupervisorBasketActivity(events) {
  return events.some(isSupervisorBasketRequestEvidence);
}

/** Each row is recorded evidence, not a correlated tool execution or inferred outcome. */
export function projectBasketActivityEvent(event) {
  if (!isBasketStatusEvent(event)) return null;
  return {
    phase: event.phase,
    label: basketStatusLabel(event),
    status: BASKET_ACTIVITY_STATUSES[event.phase],
  };
}
