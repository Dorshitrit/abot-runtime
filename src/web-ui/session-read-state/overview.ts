import type { SessionMetadata } from "../../sessions/metadata/projection.js";
import type { WebReadState } from "./store.js";
import { projectSessionReadState } from "./projection.js";
import { unavailableSessionReadState } from "./availability.js";

/** The home dashboard's count and three recent chats must not become page-local. */
export function sessionListOverview(records: SessionMetadata[], archivedIds: unknown, state?: WebReadState) {
  const archived = new Set(Array.isArray(archivedIds) ? archivedIds : []);
  const visible = records.filter(({ summary }) => !archived.has(summary.id));
  let unreadCount = 0;
  const recent = visible.slice(0, 3).map(({ summary, messages }) => ({
    ...summary,
    ...(state ? projectSessionReadState(state, summary.id, messages) : unavailableSessionReadState(summary.id)),
  }));
  if (state) for (const { summary, messages } of visible) unreadCount += projectSessionReadState(state, summary.id, messages).unreadCount;
  return { sessions: recent, unreadCount, hasUnavailableReadState: !state };
}
