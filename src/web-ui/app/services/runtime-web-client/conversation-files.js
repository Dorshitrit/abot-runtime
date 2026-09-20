const PREVIEW_KINDS = new Set(["text", "image", "unsupported"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function hasSupportedPreviewResponse(payload) {
  const file = payload?.file;
  if (payload?.ok !== true || !file) return false;
  if (!PREVIEW_KINDS.has(file.kind)) return false;
  if (typeof file.name !== "string" || file.name.length > 4096) return false;
  if (typeof file.mimeType !== "string") return false;
  if (!Number.isSafeInteger(file.size) || file.size < 0) return false;
  if (file.kind === "text" && typeof file.content !== "string") return false;
  if (file.kind === "image" && !IMAGE_MIME_TYPES.has(file.mimeType))
    return false;
  return true;
}

export function createConversationFileRequests({
  requestApi,
  resolveApiPath,
  origin,
  getConfig,
}) {
  const supportsConversationFiles = () => getConfig()?.backend === "runtime";
  function path(
    { environmentId, sessionId, requestId, executionId, mode },
    action = "",
  ) {
    const query = new URLSearchParams({
      environment: environmentId,
      sessionId,
      requestId,
      executionId,
    });
    if (mode === "download") query.set("download", "1");
    if (mode === "content") query.set("content", "1");
    return "/chat/files" + action + "?" + query;
  }

  function conversationFileUrl(input) {
    if (!supportsConversationFiles()) return "";
    const url = new URL(resolveApiPath(path(input)), origin);
    if (url.origin !== new URL(origin).origin) return "";
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.pathname + url.search;
  }

  async function loadConversationFile(input) {
    if (!conversationFileUrl(input))
      throw new Error("File preview is unavailable.");
    const payload = await requestApi(path(input), { signal: input.signal });
    if (!hasSupportedPreviewResponse(payload))
      throw new Error("Invalid file preview.");
    return payload;
  }

  async function openConversationFile(input) {
    if (!conversationFileUrl(input))
      throw new Error("Opening this file on Mac is unavailable.");
    const result = await requestApi(path(input, "/open"), {
      method: "POST",
      body: "{}",
      signal: input.signal,
    });
    if (result?.ok !== true)
      throw new Error("The file could not be opened on your Mac.");
    return result;
  }

  return {
    supportsConversationFiles,
    openConversationFile,
    loadConversationFile,
    conversationFileUrl,
  };
}
