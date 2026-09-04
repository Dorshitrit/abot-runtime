import {
  normalizeLegacyWebSources,
  normalizeWebSources,
} from "./web-sources.js";

function isCompletedWebTool(message) {
  const name = message.name || message.rawType || message.type;
  if (name !== "tool.completed") return false;
  if (message.ok !== true) return false;
  return message.tool === "web_search" || message.tool === "web_fetch";
}

export function projectWebSourceEvent(message) {
  if (!isCompletedWebTool(message)) return null;
  const meta = message.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  if (Object.hasOwn(meta, "webSources")) {
    return normalizeWebSources(meta.webSources, message.tool);
  }
  return normalizeLegacyWebSources(meta, message.tool);
}
