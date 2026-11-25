export type RuntimeBridgeConnection = Readonly<{ runtimeId: string; url: string; token: string }>;

/** Local IPC receives transport credentials from the caller that explicitly enables the bridge. */
export function validateRuntimeBridgeConnection(value: unknown, runtimeId: string): RuntimeBridgeConnection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("runtime_bridge_connection_invalid");
  const fields = value as Record<string, unknown>;
  if (fields.runtimeId !== runtimeId || typeof fields.url !== "string" || fields.url.length > 4096 ||
      typeof fields.token !== "string" || !/^[\x21-\x7E]{1,4096}$/.test(fields.token))
    throw new Error("runtime_bridge_connection_invalid");
  const url = URL.canParse(fields.url) ? new URL(fields.url) : undefined;
  if (!url || !["wss:", "ws:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash)
    throw new Error("runtime_bridge_connection_invalid");
  return { runtimeId, url: url.href, token: fields.token };
}
