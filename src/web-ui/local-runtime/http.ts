import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConfigFileKind } from "../config-dashboard-backend.js";
import type { JsonObject } from "./contracts.js";

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: JsonObject,
): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

export function sendAttachmentBytes(
  res: ServerResponse,
  bytes: Buffer,
  mimeType: string,
): void {
  res.writeHead(200, {
    "cache-control": "private, no-store",
    "content-length": String(bytes.byteLength),
    "content-type": mimeType,
    "x-content-type-options": "nosniff",
  });
  res.end(bytes);
}

export function readBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytesRead += chunk.byteLength;
      if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
        rejectOnce(new Error("request_body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on("error", rejectOnce);
  });
}

export function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function getNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readJsonBody(body: Buffer): JsonObject {
  if (body.length === 0) return {};
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object body required");
  }
  return parsed as JsonObject;
}

export function requestEnvironmentId(
  url: URL,
  body: JsonObject | null,
  fallback: string,
): string {
  return (
    getString(body?.environment) ||
    getString(body?.environmentId) ||
    getString(url.searchParams.get("environment")) ||
    getString(url.searchParams.get("environmentId")) ||
    fallback
  )
    .trim()
    .toLowerCase();
}

export function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

export function readConfigFileKind(value: unknown): ConfigFileKind | null {
  const kind = getString(value);
  return kind === "runtime" || kind === "requestRunner" || kind === "model"
    ? kind
    : null;
}
