import type { IncomingMessage } from "node:http";
import { isNativeLoopbackAddress } from "../../computer-access/companion/native-address.js";
import { hasLoopbackRequestAuthority } from "../request-authority.js";

/** Native preparation controls this listener's Mac, never a remote browser's OS. */
export function hasLocalRuntimeRequestAuthority(request: IncomingMessage): boolean {
  if (!hasLoopbackRequestAuthority(request)) return false;
  if (!isNativeLoopbackAddress(request.socket.remoteAddress ?? "")) return false;
  if (!isNativeLoopbackAddress(request.socket.localAddress ?? "")) return false;
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  const authority = new URL(`${encrypted ? "https" : "http"}://${request.headers.host}`);
  const port = Number(authority.port || (encrypted ? 443 : 80));
  return port === request.socket.localPort;
}
