const DELEGATED_ROLES = new Set([
  "planner", "worker", "researcher", "reviewer",
]);

export function isRoleDelegationEvent(event) {
  return (event?.eventName || event?.name || event?.rawType || event?.type)
    === "role.delegated";
}

function hasDelegationIdentity(value) {
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

function hasDelegationObjective(value) {
  if (typeof value !== "string") return false;
  if (value.length > 8_192) return false;
  return value.trim().length > 0;
}

/** Explicit committed delegation evidence, without inferred role or objective data. */
export function projectRoleDelegationEvent(event) {
  if (!isRoleDelegationEvent(event)) return null;
  const source = event.roleDelegation || event;
  if (source.callerRole !== "supervisor") return null;
  if (!DELEGATED_ROLES.has(source.childRole)) return null;
  if (!hasDelegationIdentity(event.requestId)) return null;
  if (!hasDelegationIdentity(source.callerCallId)) return null;
  if (!hasDelegationIdentity(source.childCallId)) return null;
  if (!hasDelegationObjective(source.objective)) return null;
  if (source.generation !== undefined && typeof source.generation !== "string")
    return null;
  const generation = source.generation || "";
  return {
    id: JSON.stringify([event.requestId, generation, source.childCallId]),
    generation,
    callerCallId: source.callerCallId,
    callerRole: source.callerRole,
    childCallId: source.childCallId,
    childRole: source.childRole,
    objective: source.objective,
  };
}

export function hasRecordedRoleDelegation(events, delegation) {
  return events.some((event) => event.roleDelegation?.id === delegation.id);
}
