/** The permanent companion is intentionally omitted from ordinary session lists. */
export function scheduleConversationLabel(sessionId, sessions = []) {
  if (sessionId === "spark-companion") return "SPARK Chat";
  const session = sessions.find((item) => item.id === sessionId);
  return session?.title || sessionId;
}

export function scheduleConversationOptions(sessions, selectedSessionId) {
  const options = sessions.map((session) => ({
    value: session.id,
    label: scheduleConversationLabel(session.id, sessions),
  }));
  if (!selectedSessionId) return options;
  if (options.some((option) => option.value === selectedSessionId)) return options;
  return [...options, {
    value: selectedSessionId,
    label: scheduleConversationLabel(selectedSessionId, sessions),
  }];
}
