import type { IncomingMessage } from "node:http";

/** Native downloads and sockets do not accept browser-origin credentials. */
export function hostBearerCredential(request: IncomingMessage): string | undefined {
  if (request.headers.origin !== undefined) return undefined;
  if (request.headers["sec-fetch-site"] !== undefined) return undefined;
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  return /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header)?.[1];
}
