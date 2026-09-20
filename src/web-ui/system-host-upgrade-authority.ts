import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  hasLoopbackRequestAuthority,
  hasTrustedWebUiAuthority,
} from "./request-authority.js";
import { hostBearerCredential } from "./system-host-setup/native-authorization.js";

/** Native upgrades retain credential authentication and never accept browser metadata. */
export function hasTrustedSystemHostUpgrade(
  request: IncomingMessage,
  listenHost: string,
): boolean {
  if (!hostBearerCredential(request)) return false;
  if (hasTrustedWebUiAuthority(request, listenHost)) return true;
  return hasLoopbackRequestAuthority(request);
}

export function rejectSystemHostUpgrade(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}
