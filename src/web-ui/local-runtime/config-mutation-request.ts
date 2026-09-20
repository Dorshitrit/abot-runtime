import { sendJson } from "./http.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export class ConfigMutationRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 403,
  ) {
    super(message);
  }
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const value = request.headers["content-type"] ?? "";
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function hasSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const encrypted = "encrypted" in request.socket && request.socket.encrypted;
    const expectedOrigin = `${encrypted ? "https:" : "http:"}//${request.headers.host}`;
    return parsed.origin === expectedOrigin;
  } catch {
    return false;
  }
}

/** Browser writes to machine-local configuration require same-origin JSON. */
export function assertConfigMutationRequest(request: IncomingMessage): void {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new ConfigMutationRequestError(
      "Cross-site configuration changes are not allowed.",
    );
  }
  if (!hasSameOrigin(request)) {
    throw new ConfigMutationRequestError(
      "Configuration changes require the same origin.",
    );
  }
  if (!hasJsonContentType(request)) {
    throw new ConfigMutationRequestError(
      "Configuration changes require application/json.",
      415,
    );
  }
}

export function acceptConfigMutationRequest(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  try {
    assertConfigMutationRequest(request);
    return true;
  } catch (error) {
    const status =
      error instanceof ConfigMutationRequestError ? error.statusCode : 403;
    sendJson(response, status, {
      ok: false,
      error: "configuration_request_rejected",
      message: "Configuration changes require same-origin JSON requests.",
    });
    return false;
  }
}
