export function isRoleReturnEvent(event) {
  return (event?.eventName || event?.name || event?.rawType || event?.type)
    === "role.returned";
}

function hasReturnIdentity(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function projectRoleReturnEvent(event) {
  if (!isRoleReturnEvent(event)) return null;
  const source = event.roleReturn || event;
  if (source.callerRole !== "supervisor") return null;
  if (source.childRole !== "planner") return null;
  if (source.outcome !== "completed" && source.outcome !== "failed") return null;
  if (!hasReturnIdentity(event.requestId)) return null;
  if (!hasReturnIdentity(source.callerCallId)) return null;
  if (!hasReturnIdentity(source.childCallId)) return null;
  if (typeof source.summary !== "string" || !source.summary.trim()) return null;
  if (source.generation !== undefined && typeof source.generation !== "string") return null;
  const generation = source.generation || "";
  return {
    id: JSON.stringify([event.requestId, generation, source.childCallId]),
    generation,
    callerCallId: source.callerCallId,
    callerRole: source.callerRole,
    childCallId: source.childCallId,
    childRole: source.childRole,
    outcome: source.outcome,
    summary: source.summary,
  };
}

export function hasRecordedRoleReturn(events, receipt) {
  return events.some((event) => event.roleReturn?.id === receipt.id);
}
