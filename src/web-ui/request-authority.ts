import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

function normalizeIpAddress(value: string): string | undefined {
  const address = value.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (!family) return undefined;
  const ipv6 = family === 4 ? "::ffff:" + address : address;
  try {
    return new URL("http://[" + ipv6 + "]").hostname;
  } catch {
    return undefined;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === "[::1]") return true;
  return /^\[::ffff:7f[0-9a-f]{2}:/.test(address);
}

function hasSingleHostHeader(request: IncomingMessage): boolean {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "host") count += 1;
  }
  return count === 1;
}

function readRequestAuthority(request: IncomingMessage): URL | undefined {
  if (!hasSingleHostHeader(request)) return undefined;
  const host = request.headers.host;
  if (!host || /[\s,/\\?#@]/u.test(host)) return undefined;
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  try {
    return new URL((encrypted ? "https://" : "http://") + host);
  } catch {
    return undefined;
  }
}

function hasListenerPort(authority: URL, request: IncomingMessage): boolean {
  const defaultPort = authority.protocol === "https:" ? 443 : 80;
  const port = authority.port ? Number(authority.port) : defaultPort;
  return port === request.socket.localPort;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isConfiguredHostname(hostname: string, listenHost: string): boolean {
  const configured = normalizeHostname(listenHost.trim());
  if (["*", "0.0.0.0", "::", "[::]"].includes(configured)) return false;
  return normalizeHostname(hostname) === configured;
}

function hasTrustedListenerHostname(
  hostname: string,
  localAddress: string,
  listenHost: string,
): boolean {
  const localIp = normalizeIpAddress(localAddress);
  const hostIp = normalizeIpAddress(hostname);
  if (hostIp && hostIp === localIp) return true;
  if (isConfiguredHostname(hostname, listenHost)) return true;
  if (!isLoopbackAddress(localIp)) return false;
  if (normalizeHostname(hostname) === "localhost") return true;
  return isLoopbackAddress(hostIp);
}

function hasPublishedLoopbackAuthority(
  request: IncomingMessage,
  allowed: boolean,
): boolean {
  if (!allowed) return false;
  return hasLoopbackRequestAuthority(request);
}

/** Trust the configured listener and local interface, never request DNS or proxy headers. */
export function hasTrustedWebUiAuthority(
  request: IncomingMessage,
  listenHost: string,
  allowPublishedLoopback = false,
): boolean {
  const authority = readRequestAuthority(request);
  if (!authority) return false;
  const localAddress = request.socket.localAddress;
  if (!localAddress) return false;
  if (hasPublishedLoopbackAuthority(request, allowPublishedLoopback))
    return true;
  if (!hasListenerPort(authority, request)) return false;
  return hasTrustedListenerHostname(
    authority.hostname,
    localAddress,
    listenHost,
  );
}

/** A native client may use a Docker-published loopback port unlike the listener port. */
export function hasLoopbackRequestAuthority(request: IncomingMessage): boolean {
  const authority = readRequestAuthority(request);
  if (!authority) return false;
  const hostname = normalizeHostname(authority.hostname);
  if (hostname === "localhost") return true;
  if (hostname.endsWith(".localhost")) return true;
  return isLoopbackAddress(normalizeIpAddress(hostname));
}

export function acceptWebUiHttpAuthority(
  request: IncomingMessage,
  response: ServerResponse,
  listenHost: string,
  allowPublishedLoopback = false,
): boolean {
  if (hasTrustedWebUiAuthority(request, listenHost, allowPublishedLoopback))
    return true;
  response.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    JSON.stringify({
      ok: false,
      error: "web_ui_authority_rejected",
      message:
        "Use the configured Web UI hostname or a local listener address.",
    }),
  );
  return false;
}

function hasTrustedWebUiUpgrade(
  request: IncomingMessage,
  listenHost: string,
  allowPublishedLoopback: boolean,
): boolean {
  if (!hasTrustedWebUiAuthority(request, listenHost, allowPublishedLoopback))
    return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === readRequestAuthority(request)?.origin;
}

export function acceptWebUiUpgradeAuthority(
  request: IncomingMessage,
  socket: Duplex,
  listenHost: string,
  allowPublishedLoopback = false,
): boolean {
  if (hasTrustedWebUiUpgrade(request, listenHost, allowPublishedLoopback))
    return true;
  socket.destroy();
  return false;
}
