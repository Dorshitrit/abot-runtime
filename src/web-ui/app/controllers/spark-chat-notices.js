function persistedAssistantMessages(snapshot) {
  return (snapshot?.messages || []).filter((message) => message.role === "assistant" && message.id != null);
}
function messageIdentity(message) { return JSON.stringify([String(message.id), message.createdAt, message.requestId || null]); }

export function createSparkChatNotices({ showNotice, setUnread, isVisible = () => document.visibilityState === "visible" }) {
  let initialized = false;
  let seen = new Set();
  let deferredCount = 0;
  function reconcile(snapshot, readState, { consolidated = false } = {}) {
    const messages = persistedAssistantMessages(snapshot);
    const fresh = messages.filter((message) => !seen.has(messageIdentity(message)));
    seen = new Set(messages.map(messageIdentity));
    const count = Number(readState?.unreadCount) || 0;
    if (Number.isFinite(readState?.unreadCount)) setUnread(count);
    if (!isVisible()) {
      deferredCount = count;
      initialized = true;
      return;
    }
    if (!initialized || consolidated || deferredCount) {
      initialized = true;
      deferredCount = 0;
      if (count) showNotice(`${count} unread ${count === 1 ? "message" : "messages"}`);
      return;
    }
    if (!fresh.length) return;
    for (const message of fresh) showNotice(String(message.text || message.content || "").slice(0, 350));
  }
  return {
    reconcile,
    reset() { initialized = false; seen.clear(); deferredCount = 0; setUnread(0); },
  };
}
