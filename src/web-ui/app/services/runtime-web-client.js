import { createLongTermMemoryRequests } from "./runtime-web-client/memory.js";

export function parseJsonResponseText(text, context) {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.trim().replaceAll(/\s+/g, " ").slice(0, 140);
    throw new Error(`${context} returned non-JSON: ${preview || "empty body"}`);
  }
}

export class RuntimeWebClientError extends Error {
  constructor(message, { status, code, payload } = {}) {
    super(message);
    this.name = "RuntimeWebClientError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export function createRuntimeWebClient({
  getConfig,
  getEnvironmentId,
  fetchImpl = fetch,
  origin = window.location.origin,
}) {
  const environmentQuery = (environmentId = getEnvironmentId()) =>
    encodeURIComponent(environmentId);
  const resolveApiPath = (path) => {
    const base = getConfig()?.apiBasePath || "/web-api";
    return `${base}${path}`;
  };
  const resolveAgentModePath = (environmentId = getEnvironmentId()) => {
    const url = new URL(
      getConfig()?.agentModePath || "/web-agent-mode",
      origin,
    );
    url.searchParams.set("environment", environmentId);
    return `${url.pathname}${url.search}`;
  };
  const attachmentPath = ({
    environmentId,
    sessionId,
    storageRef,
    id,
    mimeType,
    name,
  }) => {
    const params = new URLSearchParams({
      environment: environmentId,
      sessionId,
      ...(storageRef ? { storageRef } : {}),
      ...(id ? { id } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(name ? { name } : {}),
    });
    return `/chat/attachments?${params}`;
  };

  async function request(url, context, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const data = parseJsonResponseText(await response.text(), context);
    if (!response.ok) {
      throw new RuntimeWebClientError(
        data.message || data.error || `HTTP ${response.status}`,
        {
          status: response.status,
          code: typeof data.error === "string" ? data.error : "",
          payload: data,
        },
      );
    }
    return data;
  }

  const requestApi = (path, options = {}) =>
    request(resolveApiPath(path), path, options);
  const longTermMemoryRequests = createLongTermMemoryRequests({
    requestApi,
    getEnvironmentId,
    environmentQuery,
  });

  return {
    getRuntimeStatus() {
      return requestApi("/runtime/status");
    },

    getRuntimeLogs(lines = 100) {
      return requestApi(`/runtime/logs?lines=${encodeURIComponent(lines)}`);
    },

    getSystemHealth() {
      return request(getConfig()?.healthPath || "/web-health", "health");
    },

    listModels(environmentId = getEnvironmentId()) {
      return requestApi(
        `/chat/models?environment=${environmentQuery(environmentId)}`,
      );
    },

    getAgentMode(environmentId = getEnvironmentId()) {
      return request(resolveAgentModePath(environmentId), "agent-mode");
    },

    setAgentMode(mode, environmentId = getEnvironmentId()) {
      return request(resolveAgentModePath(environmentId), "agent-mode", {
        method: "POST",
        body: JSON.stringify({ mode, environment: environmentId }),
      });
    },

    attachmentPreviewUrl(input) {
      return resolveApiPath(attachmentPath(input));
    },

    async deleteAttachment(input) {
      await fetchImpl(resolveApiPath(attachmentPath(input)), {
        method: "DELETE",
      });
    },

    async uploadAttachment({ environmentId, sessionId, name, mimeType, file }) {
      const response = await fetchImpl(
        resolveApiPath(attachmentPath({ environmentId, sessionId, name })),
        {
          method: "POST",
          headers: { "content-type": mimeType },
          body: file,
        },
      );
      const data = parseJsonResponseText(
        await response.text(),
        "attachment upload",
      );
      if (!response.ok) {
        throw new Error(
          data.error || data.message || `HTTP ${response.status}`,
        );
      }
      if (!data.attachment) {
        throw new Error("attachment missing from upload response");
      }
      return data.attachment;
    },

    async loadWebConfig() {
      const response = await fetchImpl("/web-config");
      return response.json();
    },

    listSessions(environmentId = getEnvironmentId()) {
      return requestApi(
        `/chat/sessions?environment=${environmentQuery(environmentId)}`,
      );
    },

    loadSession(sessionId, environmentId = getEnvironmentId()) {
      return requestApi(
        `/chat/sessions/${encodeURIComponent(
          sessionId,
        )}/messages?environment=${environmentQuery(environmentId)}`,
      );
    },

    markSessionRead({
      sessionId,
      environmentId = getEnvironmentId(),
      readThroughMessageId = null,
    }) {
      const numericReadThrough =
        typeof readThroughMessageId === "number" &&
        Number.isFinite(readThroughMessageId)
          ? Math.max(0, Math.floor(readThroughMessageId))
          : null;
      return requestApi(
        `/chat/sessions/${encodeURIComponent(
          sessionId,
        )}/read?environment=${environmentQuery(environmentId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            readThroughMessageId: numericReadThrough,
            lastReadMessageId:
              numericReadThrough === null ? null : String(numericReadThrough),
          }),
        },
      );
    },

    clearSessionMessages(sessionId, environmentId = getEnvironmentId()) {
      return requestApi(
        `/chat/sessions/${encodeURIComponent(
          sessionId,
        )}/messages?environment=${environmentQuery(environmentId)}`,
        { method: "DELETE" },
      );
    },

    deleteSession(sessionId, environmentId = getEnvironmentId()) {
      return requestApi(
        `/chat/sessions/${encodeURIComponent(
          sessionId,
        )}?environment=${environmentQuery(environmentId)}`,
        { method: "DELETE" },
      );
    },

    async fetchRequestEvents({
      requestId,
      afterSeq = 0,
      environmentId = getEnvironmentId(),
    }) {
      const response = await fetchImpl(
        `${resolveApiPath(
          `/requests/${encodeURIComponent(requestId)}/events`,
        )}?afterSeq=${afterSeq}&environment=${environmentQuery(environmentId)}`,
      );
      if (response.status === 204 || response.status === 404) return [];
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(
          payload.error || payload.message || `HTTP ${response.status}`,
        );
      }
      return Array.isArray(payload)
        ? payload
        : Array.isArray(payload.events)
          ? payload.events
          : [];
    },

    async postChatMessage({
      text,
      attachments,
      environmentId = getEnvironmentId(),
      sessionId,
      agentMode,
      toolPermissionMode,
      modelPreference,
    }) {
      const result = await requestApi("/chat/messages", {
        method: "POST",
        body: JSON.stringify({
          text,
          environment: environmentId,
          sessionId,
          agentMode,
          toolPermissionMode,
          attachments,
          ...(modelPreference ? { modelPreference } : {}),
        }),
      });
      const requestId =
        typeof result.requestId === "string" ||
        typeof result.requestId === "number" ||
        typeof result.requestId === "boolean"
          ? String(result.requestId)
          : "";
      if (!requestId) throw new Error("requestId missing from chat response");
      return requestId;
    },

    loadConfigDashboard(environmentId = getEnvironmentId()) {
      return requestApi(
        `/runtime/config/dashboard?environment=${environmentQuery(
          environmentId,
        )}`,
      );
    },

    saveConfigFile({ environmentId = getEnvironmentId(), kind, id, config }) {
      return requestApi("/runtime/config/dashboard/file", {
        method: "PUT",
        body: JSON.stringify({
          environment: environmentId,
          kind,
          id,
          config,
        }),
      });
    },

    ...longTermMemoryRequests,
  };
}
