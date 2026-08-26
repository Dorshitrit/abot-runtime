const storageKeys = {
  environmentId: "abot-web.environmentId",
  pinnedSessions: "abot-web.pinnedSessions",
  currentSessionByEnvironment: "abot-web.currentSessionByEnvironment",
  sessionModes: "abot-web.sessionModes",
  sessionModels: "abot-web.sessionModels",
  lastModelByEnvironment: "abot-web.lastModelByEnvironment",
};

function parseObject(storage, key) {
  try {
    const raw = storage.getItem(key);
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

export function createClientPreferences(storage) {
  return {
    loadPinnedSessions() {
      try {
        const raw = storage.getItem(storageKeys.pinnedSessions);
        const value = raw ? JSON.parse(raw) : [];
        return Array.isArray(value)
          ? value.map((id) => String(id || "")).filter(Boolean)
          : [];
      } catch {
        return [];
      }
    },

    savePinnedSessions(sessionIds) {
      storage.setItem(storageKeys.pinnedSessions, JSON.stringify(sessionIds));
    },

    loadSessionModes(normalizeToolPermissionMode) {
      const modes = Object.fromEntries(
        Object.entries(parseObject(storage, storageKeys.sessionModes)).flatMap(
          ([sessionId, value]) =>
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            normalizeToolPermissionMode(value.toolPermissionMode) === "ask"
              ? [
                  [
                    sessionId,
                    {
                      toolPermissionMode: "ask",
                      savedAt: value.savedAt || Date.now(),
                    },
                  ],
                ]
              : [],
        ),
      );
      storage.setItem(storageKeys.sessionModes, JSON.stringify(modes));
      return modes;
    },

    saveSessionModes(modes) {
      storage.setItem(storageKeys.sessionModes, JSON.stringify(modes));
    },

    loadModelPreferences() {
      return {
        sessionModels: parseObject(storage, storageKeys.sessionModels),
        lastModelByEnvironment: parseObject(
          storage,
          storageKeys.lastModelByEnvironment,
        ),
      };
    },

    saveModelPreferences(sessionModels, lastModelByEnvironment) {
      storage.setItem(storageKeys.sessionModels, JSON.stringify(sessionModels));
      storage.setItem(
        storageKeys.lastModelByEnvironment,
        JSON.stringify(lastModelByEnvironment),
      );
    },

    environmentId() {
      return String(storage.getItem(storageKeys.environmentId) || "").trim();
    },

    saveEnvironmentId(environmentId) {
      if (environmentId)
        storage.setItem(storageKeys.environmentId, environmentId);
      else storage.removeItem(storageKeys.environmentId);
    },

    sessionIdForEnvironment(environmentId) {
      return String(
        parseObject(storage, storageKeys.currentSessionByEnvironment)[
          environmentId
        ] || "",
      );
    },

    saveSessionIdForEnvironment(environmentId, sessionId) {
      const sessions = parseObject(
        storage,
        storageKeys.currentSessionByEnvironment,
      );
      if (sessionId) sessions[environmentId] = sessionId;
      else delete sessions[environmentId];
      storage.setItem(
        storageKeys.currentSessionByEnvironment,
        JSON.stringify(sessions),
      );
    },
  };
}
