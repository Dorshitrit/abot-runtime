import type { GatewayResponse } from "./contracts.js";

function setStatus(response: GatewayResponse, status: number): void {
  response.statusCode = status;
}

export function sendText(
  response: GatewayResponse,
  status: number,
  text: string,
): void {
  setStatus(response, status);
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

export function sendJson(
  response: GatewayResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  setStatus(response, status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
