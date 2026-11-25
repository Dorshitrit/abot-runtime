import { requireValue, type Downloader } from "./contracts.js";

const HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
function allowedUrl(value: string): URL {
  const url = new URL(value);
  requireValue(url.protocol === "https:" && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443"), "unsafe_download_url", "Release downloads require an allowed HTTPS origin.");
  return url;
}

/** Fetch only the supplied pinned release; installation owns digest verification. */
export const downloadRelease: Downloader = async (release, signal) => {
  let url = allowedUrl(release.url);
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      requireValue(redirects < 4 && location, "download_redirect", "Release redirect limit exceeded or location missing.");
      url = allowedUrl(new URL(location, url).href);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      requireValue(false, "download_failed", "Release download requires HTTP 200 with a body.");
    }
    const body = response.body;
    return (async function* (): AsyncIterable<Uint8Array> {
      const reader = body.getReader();
      const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          yield chunk.value;
        }
      } finally {
        signal.removeEventListener("abort", abort);
        try { await reader.cancel(); } finally { reader.releaseLock(); }
      }
    })();
  }
};
