// A transport receipt confirms delivery. Only live Agent detail confirms a reply or work in progress.
export function agentResponseStatus(detail, sendingId) {
  const messages = detail?.messages || [];
  if (sendingId !== undefined && !messages.some((message) => message.id === sendingId)) return "Sending…";
  if (detail?.recovery?.unansweredUpdateId) return "No reply to your last update is available.";
  const mission = detail?.mission;
  if (!mission || !["active", "awaiting_user_decision"].includes(mission.status)) return "";
  const current = messages.filter((message) => message.missionId === mission.id && message.agentId === detail.agent.id);
  const liveReplies = new Set(detail.replyingToMessageIds);
  const publishedReplies = new Set(current.filter((message) => message.role === "assistant").map((message) => message.id));
  const preparingReply = current.some((message) => message.role === "user" && message.purpose === "conversation" &&
    liveReplies.has(message.id) && !publishedReplies.has(`reply:${message.id}`));
  if (preparingReply) return "Preparing a reply…";
  if (mission.status !== "active" || !["thinking", "working"].includes(detail.status)) return "";
  if (current[0]?.role !== "user" || (current[0].source !== null && current[0].directInput !== true)) return "";
  if (detail.hasWork) return "Working on your task…";
  return detail.status === "thinking" ? "Thinking…" : "";
}
