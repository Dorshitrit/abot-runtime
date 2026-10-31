function hasUnreadNotifications(snapshot) {
  if (!snapshot.supported) return false;
  if (!Number.isSafeInteger(snapshot.unreadCount)) return false;
  return snapshot.unreadCount > 0;
}

/** Reflect the shared inbox count without reading or changing notification state. */
export function createNotificationFavicon({ documentRoot = document } = {}) {
  const icon = documentRoot.querySelector?.('link[rel~="icon"]');
  if (!icon) return { render() {} };
  const originalHref = icon.getAttribute("href") || "/favicon.svg";
  return {
    render(snapshot) {
      const href = hasUnreadNotifications(snapshot) ? "/favicon-unread.svg" : originalHref;
      if (icon.getAttribute("href") === href) return;
      icon.setAttribute("href", href);
    },
  };
}
