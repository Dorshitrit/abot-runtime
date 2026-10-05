export function canLoadOlderNotifications(snapshot) {
  if (!snapshot.nextCursor) return false;
  if (snapshot.filter !== "unread") return true;
  return hasOlderUnreadNotifications(snapshot);
}

export function hasOlderUnreadNotifications(snapshot) {
  if (!snapshot.nextCursor) return false;
  if (snapshot.filter !== "unread") return false;
  const loadedUnreadCount = (snapshot.items || [])
    .filter((item) => item.readAt == null).length;
  return snapshot.unreadCount > loadedUnreadCount;
}
