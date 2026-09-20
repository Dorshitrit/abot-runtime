import { lookup as lookupHost } from "node:dns/promises";
import { isIP } from "node:net";
import { HOST_SOCKET_PATH } from "./protocol.js";

export type NativeAddress = Readonly<{ address: string; family: number }>;
export type NativeHostResolver = (
  hostname: string,
) => Promise<readonly NativeAddress[]>;

export function isNativeLoopbackAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/gu, "");
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  if (family !== 6) return false;
  const normalized = new URL(`http://[${address}]`).hostname;
  if (normalized === "[::1]") return true;
  return /^\[::ffff:7f[0-9a-f]{2}:/u.test(normalized);
}

export function normalizeNativeRuntimeUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "ws:", "https:", "wss:"].includes(url.protocol))
    throw new Error("Use an HTTP or WebSocket URL for the local ABot Runtime.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "The Runtime URL must not contain credentials, a query, or a fragment.",
    );
  if (url.pathname !== "/")
    throw new Error("Use the Runtime origin without a path.");
  url.protocol = ["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:";
  return url.origin;
}

/** Resolve once, reject mixed/public answers, then pin this exact address at connect. */
export async function resolveNativeRuntimeAddress(
  value: string,
  resolveHost: NativeHostResolver = (hostname) =>
    lookupHost(hostname, { all: true }),
): Promise<Readonly<{ url: string; address: NativeAddress }>> {
  const origin = normalizeNativeRuntimeUrl(value);
  const url = new URL(origin);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const addresses =
    hostname === "localhost" || hostname.endsWith(".localhost")
      ? [{ address: "127.0.0.1", family: 4 }]
      : await resolveHost(hostname);
  if (addresses.length === 0)
    throw new Error("The local Runtime address did not resolve.");
  if (!addresses.every(({ address }) => isNativeLoopbackAddress(address)))
    throw new Error(
      "The host companion connects only to a Runtime on this computer's loopback interface.",
    );
  url.pathname = HOST_SOCKET_PATH;
  return { url: url.toString(), address: addresses[0]! };
}
