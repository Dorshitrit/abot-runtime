const storageKey = "abot-web.keptSparkConversations";
const receiptLimit = 500;

export function createSparkConversationPreferences(storage) {
  function receipts() {
    try {
      const value = JSON.parse(storage.getItem(storageKey) || "[]");
      return Array.isArray(value)
        ? value.filter((key) => typeof key === "string").slice(-receiptLimit)
        : [];
    } catch {
      return [];
    }
  }

  const keyFor = (environmentId, sessionId) => JSON.stringify([environmentId, sessionId]);
  return {
    hasKeptSparkConversation(environmentId, sessionId) {
      return receipts().includes(keyFor(environmentId, sessionId));
    },
    keepSparkConversation(environmentId, sessionId) {
      const key = keyFor(environmentId, sessionId);
      const kept = receipts().filter((value) => value !== key);
      storage.setItem(storageKey, JSON.stringify([...kept, key].slice(-receiptLimit)));
    },
  };
}
