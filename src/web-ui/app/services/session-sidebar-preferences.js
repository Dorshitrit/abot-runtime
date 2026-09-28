const storageKey = "abot-web.sessionSidebarByEnvironment";

function sessionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === "string" && id))];
}

function readEnvironments(storage) {
  try {
    const value = JSON.parse(storage.getItem(storageKey) || "{}");
    if (!value || typeof value !== "object") return {};
    if (Array.isArray(value)) return {};
    return value;
  } catch {
    return {};
  }
}

export function createSessionSidebarPreferences(storage) {
  return {
    loadSessionSidebar(environmentId) {
      const saved = readEnvironments(storage)[environmentId];
      return {
        archivedSessionIds: sessionIds(saved?.archivedSessionIds),
        orderedSessionIds: sessionIds(saved?.orderedSessionIds),
      };
    },
    saveSessionSidebar(environmentId, value) {
      const environments = readEnvironments(storage);
      Object.defineProperty(environments, environmentId, {
        value: {
          archivedSessionIds: sessionIds(value.archivedSessionIds),
          orderedSessionIds: sessionIds(value.orderedSessionIds),
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      storage.setItem(storageKey, JSON.stringify(environments));
    },
  };
}
