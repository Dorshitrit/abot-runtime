const MAX_SOURCE_URL_LENGTH = 4_096;

export function parseWebSourceUrl(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_SOURCE_URL_LENGTH) return null;
  if (/[\u0000-\u0020\u007f]/u.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function canLoadOriginIcon(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (!host.includes(".")) return false;
  if (host.startsWith("[")) return false;
  if (/^\d+(?:\.\d+){3}$/u.test(host)) return false;
  const localSuffixes = [".localhost", ".local", ".internal", ".home", ".lan"];
  return !localSuffixes.some((suffix) => host.endsWith(suffix));
}

export function webSourceFaviconUrl(value) {
  const url = parseWebSourceUrl(value);
  if (!url || !canLoadOriginIcon(url.hostname)) return "";
  return `${url.origin}/favicon.ico`;
}
