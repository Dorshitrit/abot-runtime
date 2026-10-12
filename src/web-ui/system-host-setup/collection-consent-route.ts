import type { IncomingMessage, ServerResponse } from "node:http";
import { acceptCollectionConsent } from "../../computer-access/collection-consent.js";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "../local-runtime/http.js";

export const COLLECTION_CONSENT_PATH = "/web-api/runtime/system-host/collection-consent";

function hasExplicitCollectionAcknowledgment(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 1) return false;
  return (value as Record<string, unknown>).acknowledged === true;
}

export async function handleCollectionConsent(
  request: IncomingMessage,
  response: ServerResponse,
  rootDir: string,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (!acceptConfigMutationRequest(request, response)) return;
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, { maxBytes: 1_024 })).toString());
  } catch { /* malformed or oversized input is rejected below */ }
  if (!hasExplicitCollectionAcknowledgment(body)) {
    sendJson(response, 400, { ok: false, error: "invalid_collection_acknowledgment" });
    return;
  }
  const collectionConsent = await acceptCollectionConsent(rootDir);
  sendJson(response, 200, { ok: true, collectionConsent });
}
