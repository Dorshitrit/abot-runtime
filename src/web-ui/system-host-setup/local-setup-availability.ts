import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { isNativeLoopbackAddress } from "../../computer-access/companion/native-address.js";
import { hasLoopbackRequestAuthority } from "../request-authority.js";
import type { HostReadiness } from "./readiness.js";

/** Local setup controls the Runtime's computer, never an inferred browser OS. */
export function canSetUpLocalMac(
  request: IncomingMessage,
  readiness: HostReadiness,
  platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  if (readiness.environment !== "native") return false;
  if (!readiness.platforms.includes("macos")) return false;
  if (readiness.ready) return false;
  if (!hasLoopbackRequestAuthority(request)) return false;
  if (!isNativeLoopbackAddress(request.socket.remoteAddress ?? "")) return false;
  if (!isNativeLoopbackAddress(request.socket.localAddress ?? "")) return false;
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  const authority = new URL(`${encrypted ? "https" : "http"}://${request.headers.host}`);
  const port = Number(authority.port || (encrypted ? 443 : 80));
  return port === request.socket.localPort;
}

/** Use only after eligibility validates the loopback listener and authority. */
export function localMacSetupRuntimeUrl(request: IncomingMessage): string {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  if (encrypted) return new URL(`https://${request.headers.host}`).origin;
  const address = request.socket.localAddress!;
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return new URL(`http://${host}:${request.socket.localPort}`).origin;
}

export function withLocalMacSetup(
  request: IncomingMessage,
  readiness: HostReadiness,
): HostReadiness {
  if (!canSetUpLocalMac(request, readiness))
    return { ...readiness, localSetupAvailable: false };
  return {
    ...readiness,
    localSetupAvailable: true,
    localComputerName: hostname(),
    message: "Connect this Mac using the installed ABot Runtime. The companion starts now and at sign-in; macOS permissions are requested separately.",
  };
}
