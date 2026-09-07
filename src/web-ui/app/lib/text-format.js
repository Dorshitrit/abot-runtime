export function textOf(value, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function shortId(id) {
  const value = textOf(id);
  return value.length > 12
    ? `${value.slice(0, 6)}...${value.slice(-4)}`
    : value;
}

export function formatTime(value) {
  if (!value) return "";
  const date =
    typeof value === "number"
      ? new Date(value)
      : /^\d+$/.test(String(value))
        ? new Date(Number(value))
        : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function hasRtlText(value) {
  return /[\u0590-\u08ff]/.test(textOf(value));
}

export function applyTextDirection(element, value) {
  const isRtl = hasRtlText(value);
  element.dir = isRtl ? "rtl" : "auto";
  element.classList.toggle("rtl-text", isRtl);
}

export function createWebSessionId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `abot-web-${Date.now()}-${random}`;
}

export function escapeHtml(value) {
  return textOf(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

export { safeLinkHref } from "./message-url-policy.js";
export { renderMarkdown } from "./message-markdown.js";
