export function safeLinkHref(value, baseHref = globalThis.location?.href) {
  if (typeof value !== "string" || !value.trim()) return "";
  if (value.length > 4_096 || /[\u0000-\u0020\u007f]/u.test(value)) return "";
  try {
    const url = new URL(value, baseHref);
    if (url.username || url.password) return "";
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    if (url.protocol === "mailto:") return url.href;
    return "";
  } catch {
    return "";
  }
}
