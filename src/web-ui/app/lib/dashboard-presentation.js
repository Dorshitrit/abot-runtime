import { formatTime, textOf } from "./text-format.js";
import { isSessionReadStateUnavailable } from "./session-read-state.js";

function timestampValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  const normalized =
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function dashboardKnownUnreadCount(session) {
  const count = Number(session.unreadCount);
  if (Number.isFinite(count) && count > 0) return Math.floor(count);
  return session.hasUnread === true ? 1 : 0;
}

export function dashboardUnreadCount(session) {
  if (isSessionReadStateUnavailable(session)) return null;
  return dashboardKnownUnreadCount(session);
}

function compareConversationRecency(left, right) {
  return timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
}

export function projectDashboardConversations(sessions = [], recentLimit = 6) {
  const unique = new Map();
  for (const session of [...sessions].sort(compareConversationRecency)) {
    const id = textOf(session.id);
    if (!id || unique.has(id)) continue;
    unique.set(id, {
      id,
      title: textOf(session.displayName || session.title || id),
      preview: textOf(session.lastMessagePreview),
      updatedAt: session.updatedAt,
      unreadCount: dashboardUnreadCount(session),
      readStateUnavailable: isSessionReadStateUnavailable(session),
      hasKnownUnreadMessages: dashboardKnownUnreadCount(session) > 0,
    });
  }
  const conversations = [...unique.values()];
  const unread = conversations.filter(
    (session) => session.hasKnownUnreadMessages,
  );
  const read = conversations.filter(
    (session) => !session.hasKnownUnreadMessages,
  );
  const availableReadSlots = Math.max(0, recentLimit - unread.length);
  return {
    conversations: [...unread, ...read.slice(0, availableReadSlots)],
    totalCount: conversations.length,
    hasUnavailableReadState: conversations.some(
      (session) => session.readStateUnavailable,
    ),
    unreadCount: unread.reduce(
      (total, session) => total + (session.unreadCount ?? 0),
      0,
    ),
  };
}

const runOutcomes = {
  pending: { label: "Waiting to run", tone: "neutral" },
  running: { label: "Running", tone: "active" },
  succeeded: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  interrupted: { label: "Interrupted", tone: "failed" },
  missed: { label: "Missed", tone: "neutral" },
};

function activityTimestamp(run) {
  return run.scheduledAt;
}

export function projectDashboardActivity(runs = [], limit = 6) {
  const ordered = [...runs].sort(
    (left, right) =>
      timestampValue(activityTimestamp(right)) -
      timestampValue(activityTimestamp(left)),
  );
  const unique = new Map();
  for (const run of ordered) {
    const id = textOf(run.id);
    if (!id || unique.has(id)) continue;
    const outcome = runOutcomes[run.status] || {
      label: "Status unavailable",
      tone: "neutral",
    };
    unique.set(id, {
      id,
      title: textOf(run.title) || "Scheduled task",
      sessionId: textOf(run.sessionId),
      requestId: textOf(run.requestId),
      timestamp: activityTimestamp(run),
      statusLabel: outcome.label,
      tone: outcome.tone,
    });
  }
  return [...unique.values()].slice(0, limit);
}

export function dashboardTimePresentation(value, now = Date.now()) {
  const timestamp = timestampValue(value);
  if (!timestamp) return null;
  const elapsed = now - timestamp;
  const date = new Date(timestamp);
  const presentation = {
    dateTime: date.toISOString(),
    title: formatTime(timestamp),
    label: date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  };
  if (elapsed < 0) return { ...presentation, label: formatTime(timestamp) };
  if (elapsed < 60000) return { ...presentation, label: "Just now" };
  if (elapsed < 3600000)
    return { ...presentation, label: `${Math.floor(elapsed / 60000)}m ago` };
  if (elapsed < 86400000)
    return { ...presentation, label: `${Math.floor(elapsed / 3600000)}h ago` };
  if (elapsed < 604800000)
    return { ...presentation, label: `${Math.floor(elapsed / 86400000)}d ago` };
  return presentation;
}
