export const PUBLIC_HTTP_LIMITS = Object.freeze({
  httpConcurrency: 6,
  httpQueueLimit: 64,
  redirects: 3,
  responseBytes: 512 * 1024,
  requestTimeoutMs: 10_000,
  responseHeaderBytes: 32 * 1024,
} as const);
