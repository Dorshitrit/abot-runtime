import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { ConversationFileError } from "./conversation-file-format.js";

function isLoopbackIp(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  if (family !== 6) return false;
  try {
    const normalized = new URL("http://[" + address + "]").hostname;
    if (normalized === "[::1]") return true;
    return /^\[::ffff:7f[0-9a-f]{2}:/.test(normalized);
  } catch {
    // Scoped IPv6 addresses may pass isIP but are not URL hostnames.
    return false;
  }
}

function readLocalAuthority(request: IncomingMessage): URL | undefined {
  if (!isLoopbackIp(request.socket.remoteAddress)) return undefined;
  if (!isLoopbackIp(request.socket.localAddress)) return undefined;
  const host = request.headers.host;
  if (!host || /[\s,/\\?#@]/u.test(host)) return undefined;
  const secure = "encrypted" in request.socket && request.socket.encrypted;
  try {
    const authority = new URL((secure ? "https://" : "http://") + host);
    const hostname = authority.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname !== "localhost" && !isLoopbackIp(hostname)) return undefined;
    const defaultPort = secure ? 443 : 80;
    const port = authority.port ? Number(authority.port) : defaultPort;
    if (port !== request.socket.localPort) return undefined;
    return authority;
  } catch {
    return undefined;
  }
}

/** Only a browser connected directly to this computer may offer native opening. */
export function isLocalNativeFileRequest(request: IncomingMessage): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const authority = readLocalAuthority(request);
  if (!authority) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === authority.origin;
}

function hasNativeOpenOrigin(request: IncomingMessage): boolean {
  if (!request.headers.origin) return false;
  return isLocalNativeFileRequest(request);
}

export function assertNativeFileOpenRequest(
  request: IncomingMessage,
  platform: NodeJS.Platform,
): void {
  if (platform !== "darwin")
    throw new ConversationFileError(
      "native_open_unavailable",
      415,
      "Opening in an app is available on this Mac only.",
    );
  if (!hasNativeOpenOrigin(request))
    throw new ConversationFileError(
      "native_open_request_rejected",
      403,
      "Open files from the Web UI on this computer.",
    );
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw new ConversationFileError(
      "native_open_request_rejected",
      415,
      "Opening a file requires a JSON request.",
    );
}
