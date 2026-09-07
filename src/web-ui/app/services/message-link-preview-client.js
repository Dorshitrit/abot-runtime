const MAX_ACTIVE_REQUESTS = 3;
const MAX_QUEUED_REQUESTS = 64;
const MAX_CACHED_PREVIEWS = 100;
const PREVIEW_CACHE_LIFETIME_MS = 4 * 60 * 1_000;
const PREVIEW_REQUEST_TIMEOUT_MS = 10_000;

async function fetchLinkPreview(fetchImpl, url) {
  if (typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    PREVIEW_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(
      `/web-link-preview?url=${encodeURIComponent(url)}`,
      {
        headers: { "X-Abot-Link-Preview": "1" },
        credentials: "same-origin",
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.ok !== true) return null;
    if (!payload.preview || typeof payload.preview !== "object") return null;
    return payload.preview;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createMessageLinkPreviewClient({
  fetchImpl = globalThis.fetch,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let activeRequests = 0;

  function rememberPreview(url, preview) {
    cache.delete(url);
    cache.set(url, {
      preview,
      expiresAt: Date.now() + PREVIEW_CACHE_LIFETIME_MS,
    });
    if (cache.size > MAX_CACHED_PREVIEWS) {
      cache.delete(cache.keys().next().value);
    }
  }

  function startQueuedRequests() {
    while (activeRequests < MAX_ACTIVE_REQUESTS && queue.length > 0) {
      const job = queue.shift();
      activeRequests += 1;
      void fetchLinkPreview(fetchImpl, job.url).then((preview) => {
        activeRequests -= 1;
        pending.delete(job.url);
        rememberPreview(job.url, preview);
        job.resolve(preview);
        startQueuedRequests();
      });
    }
  }

  function get(url) {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(url);
      cache.set(url, cached);
      return Promise.resolve(cached.preview);
    }
    cache.delete(url);
    if (pending.has(url)) return pending.get(url);
    if (queue.length >= MAX_QUEUED_REQUESTS) return Promise.resolve(null);
    let resolve;
    const promise = new Promise((settle) => {
      resolve = settle;
    });
    pending.set(url, promise);
    queue.push({ url, resolve });
    startQueuedRequests();
    return promise;
  }

  function cancelQueued() {
    for (const job of queue.splice(0)) {
      pending.delete(job.url);
      job.resolve(null);
    }
  }

  return { get, cancelQueued };
}
