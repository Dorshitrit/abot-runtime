/** A receipt cannot erase messages that arrived after its visibility snapshot. */
export function reconcileSparkReadState(previous, incoming, receipt) {
  if (!incoming) return previous;
  if (incoming.readStateStatus === "unavailable")
    return previous ? { ...previous, readStateStatus: "unavailable" } : incoming;
  const sameGeneration = previous?.readGeneration === incoming.readGeneration;
  if (receipt && previous && !sameGeneration) return previous;
  if (sameGeneration && Number(incoming.readRevision) < Number(previous.readRevision)) return previous;
  const arrivedDuringRead = receipt ? (previous?.unreadMessageIds || []).map(String)
    .filter((id) => !receipt.observedUnreadIds.includes(id)) : [];
  const unreadMessageIds = [...new Set([...(incoming.unreadMessageIds || []).map(String), ...arrivedDuringRead])];
  return { ...incoming, unreadMessageIds, unreadCount: unreadMessageIds.length, hasUnread: unreadMessageIds.length > 0 };
}
