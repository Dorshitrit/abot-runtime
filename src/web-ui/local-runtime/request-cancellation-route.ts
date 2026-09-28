import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEnvironment } from "./contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { getString, sendJson } from "./http.js";

export async function cancelWebRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  body: Record<string, unknown> | null;
  environment: RuntimeEnvironment;
}): Promise<void> {
  if (!acceptConfigMutationRequest(input.request, input.response)) return;
  const requestId = getString(input.body?.requestId).trim();
  const sessionId = getString(input.body?.sessionId).trim();
  if (!requestId || !sessionId) {
    sendJson(input.response, 400, {
      ok: false,
      error: "request_identity_required",
    });
    return;
  }
  const cancel = input.environment.requests.cancel;
  if (!cancel) {
    sendJson(input.response, 409, {
      ok: false,
      error: "cancellation_unavailable",
    });
    return;
  }
  const body = input.body;
  const wait =
    typeof body?.waitId === "string"
      ? {
          waitId: body.waitId,
          generation: getString(body.generation),
          revision: Number(body.revision),
          commandId: getString(body.commandId),
        }
      : undefined;
  const result = await cancel(requestId, sessionId, wait);
  sendJson(input.response, 200, { ok: true, ...result });
}
