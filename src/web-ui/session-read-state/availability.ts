/** Isolate UI sidecar failures; canonical session operations stay outside this boundary. */
export async function captureReadStateAvailability<T>(
  operation: () => Promise<T>,
) {
  try {
    return { readStateStatus: "available" as const, value: await operation() };
  } catch (error) {
    console.error("Web UI read tracking unavailable:", error);
    return { readStateStatus: "unavailable" as const };
  }
}

export function unavailableSessionReadState(sessionId: string) {
  return {
    sessionId,
    readStateStatus: "unavailable" as const,
    unreadCount: null,
    hasUnread: null,
    lastReadAt: null,
    lastReadMessageId: null,
  };
}
