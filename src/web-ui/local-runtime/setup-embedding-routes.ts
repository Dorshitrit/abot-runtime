import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertConfigMutationRequest,
  ConfigMutationRequestError,
} from "./config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "./http.js";
import { withHttpRequestAbortSignal } from "./request-abort.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import {
  SetupEmbeddingFailure,
  SetupEmbeddingService,
} from "./setup-embedding-service.js";

export class SetupEmbeddingRoutes {
  constructor(private readonly service: SetupEmbeddingService) {}

  async handle(params: {
    method: string;
    route: string;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    if (params.route !== "runtime/setup/embedding") return false;
    params.response.setHeader("cache-control", "no-store");
    try {
      if (params.method !== "POST") {
        sendJson(params.response, 405, {
          ok: false,
          error: "method_not_allowed",
        });
        return true;
      }
      assertConfigMutationRequest(params.request);
      const body = readJsonBody(
        await readBody(params.request, { maxBytes: 16_384 }),
      );
      const result = await withHttpRequestAbortSignal({
        request: params.request,
        response: params.response,
        reason: "embedding_setup_aborted",
        run: (signal) => this.service.enable(body, signal),
      });
      sendJson(params.response, 200, { ok: true, ...result });
    } catch (error) {
      const known =
        error instanceof RuntimeSetupError ||
        error instanceof ConfigMutationRequestError ||
        error instanceof SetupEmbeddingFailure;
      sendJson(params.response, known ? error.statusCode : 400, {
        ok: false,
        error:
          error instanceof RuntimeSetupError
            ? error.code
            : "embedding_setup_failed",
        message: known
          ? error.message
          : "Embedding setup could not be completed. Check the connection and model, then try again.",
        providerSaved:
          error instanceof SetupEmbeddingFailure && error.providerSaved,
        ...(error instanceof SetupEmbeddingFailure && error.savedProvider
          ? { savedProvider: error.savedProvider }
          : {}),
      });
    }
    return true;
  }
}
