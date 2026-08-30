import type { IncomingMessage } from "node:http";

import type { ModelGatewayRequest } from "../types.js";

export async function readJsonBody<
  T extends object = ModelGatewayRequest,
>(
  request: IncomingMessage,
): Promise<T> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
  }

  if (raw.trim().length === 0) {
    return {} as T;
  }

  const parsed = JSON.parse(raw) as unknown;
  const isObjectBody =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  return isObjectBody ? (parsed as T) : ({} as T);
}
