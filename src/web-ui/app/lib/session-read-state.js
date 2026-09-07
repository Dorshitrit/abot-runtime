function sessionReadTimestamp(value) {
  const timestamp = value?.lastReadAt ?? value?.readState?.lastReadAt;
  if (typeof timestamp !== "number") return null;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sessionReadStateStatus(value) {
  return value?.readStateStatus ?? value?.readState?.readStateStatus;
}

export function isSessionReadStateUnavailable(value) {
  return sessionReadStateStatus(value) === "unavailable";
}

export function isOlderSessionReadState(incoming, known) {
  if (isSessionReadStateUnavailable(incoming)) return false;
  const incomingTimestamp = sessionReadTimestamp(incoming);
  const knownTimestamp = sessionReadTimestamp(known);
  if (incomingTimestamp === null) return false;
  if (knownTimestamp === null) return false;
  return incomingTimestamp < knownTimestamp;
}

function preserveKnownReadState(incoming, known) {
  if (!known) return incoming;
  const preserveUnavailable = isSessionReadStateUnavailable(incoming);
  if (!preserveUnavailable && !isOlderSessionReadState(incoming, known))
    return incoming;
  const preserved = {};
  for (const field of [
    "lastReadAt",
    "lastReadMessageId",
    "unreadCount",
    "hasUnread",
  ]) {
    preserved[field] = known[field] ?? known.readState?.[field] ?? null;
  }
  return {
    ...incoming,
    ...preserved,
    readState: {
      ...incoming.readState,
      sessionId: incoming.id ?? incoming.sessionId,
      readStateStatus: sessionReadStateStatus(incoming),
      ...preserved,
    },
  };
}

export function mergeSessionReadStateUpdate(incoming, known) {
  const merged = preserveKnownReadState(incoming, known);
  if (!isSessionReadStateUnavailable(known)) return merged;
  return { ...merged, readStateStatus: "unavailable" };
}

export function mergeSessionListReadState(incomingSessions, knownSessions) {
  const knownById = new Map(
    knownSessions.map((session) => [session.id, session]),
  );
  return incomingSessions.map((session) =>
    preserveKnownReadState(session, knownById.get(session.id)),
  );
}
