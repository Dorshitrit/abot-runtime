import type { IncomingMessage } from "node:http";
import { hasLoopbackRequestAuthority } from "../request-authority.js";
import { hasSameOrigin } from "../local-runtime/config-mutation-request.js";
import { isLocalNativeFileRequest } from "../local-runtime/conversation-file-native-request.js";

/** Docker trust is supplied by the listener owner, never by request headers. */
export function isLocalChatGptManagementRequest(request: IncomingMessage, allowPublishedLoopback: boolean): boolean {
  if (isLocalNativeFileRequest(request)) return true;
  if (!allowPublishedLoopback) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  if (!hasSameOrigin(request)) return false;
  if ("encrypted" in request.socket && request.socket.encrypted) return false;
  return hasLoopbackRequestAuthority(request);
}
