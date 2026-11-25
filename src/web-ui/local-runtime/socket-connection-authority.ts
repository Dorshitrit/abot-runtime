import type { IncomingMessage } from "node:http";
import { hasLoopbackRequestAuthority } from "../request-authority.js";
import { hasSameOrigin } from "./config-mutation-request.js";
import { isLocalNativeFileRequest } from "./conversation-file-native-request.js";

/** Only the listener owner may opt into Docker's loopback publication boundary. */
export function isLocalSocketConnectionRequest(request: IncomingMessage, allowPublishedLoopback = false): boolean {
  if (isLocalNativeFileRequest(request)) return true;
  if (!allowPublishedLoopback) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  if (!hasSameOrigin(request)) return false;
  if ("encrypted" in request.socket && request.socket.encrypted) return false;
  return hasLoopbackRequestAuthority(request);
}
