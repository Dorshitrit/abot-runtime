import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigFileConflictError } from "../../runtime/adapters/config-file-transaction.js";
import {
  assertConfigMutationRequest,
  ConfigMutationRequestError,
} from "./config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "./http.js";
import {
  StepTimeoutService,
  StepTimeoutSuggestionError,
} from "./step-timeout-service.js";

export class StepTimeoutRoutes {
  constructor(private readonly service: StepTimeoutService) {}

  async handle(params: {
    method: string;
    route: string;
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
  }): Promise<boolean> {
    if (params.route !== "runtime/config/step-timeout") return false;
    params.response.setHeader("cache-control", "no-store");
    try {
      if (params.method === "GET") {
        const input = Object.fromEntries(params.url.searchParams);
        sendJson(params.response, 200, {
          ok: true,
          ...(await this.service.inspect(input)),
        });
        return true;
      }
      if (params.method === "POST") {
        assertConfigMutationRequest(params.request);
        const input = readJsonBody(
          await readBody(params.request, { maxBytes: 8_192 }),
        );
        sendJson(params.response, 200, {
          ok: true,
          ...(await this.service.increase(input)),
        });
        return true;
      }
      sendJson(params.response, 405, {
        ok: false,
        error: "method_not_allowed",
      });
    } catch (error) {
      if (error instanceof ConfigFileConflictError) {
        sendJson(params.response, 409, {
          ok: false,
          error: error.code,
          message: error.message,
        });
        return true;
      }
      if (
        error instanceof StepTimeoutSuggestionError ||
        error instanceof ConfigMutationRequestError
      ) {
        sendJson(params.response, error.statusCode, {
          ok: false,
          error:
            error instanceof StepTimeoutSuggestionError
              ? error.code
              : "config_mutation_rejected",
          message: error.message,
        });
        return true;
      }
      sendJson(params.response, 400, {
        ok: false,
        error: "timeout_suggestion_unavailable",
        message:
          "The timeout settings could not be checked. Open Model settings to review them.",
      });
    }
    return true;
  }
}
