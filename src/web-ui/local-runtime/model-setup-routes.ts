import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertConfigMutationRequest,
  ConfigMutationRequestError,
} from "./config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "./http.js";
import { ModelSetupError } from "./model-setup-input.js";
import { ModelSetupService } from "./model-setup-service.js";

export class ModelSetupRoutes {
  constructor(private readonly service: ModelSetupService) {}

  async handle(params: {
    method: string;
    route: string;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    if (
      !["runtime/config/models", "runtime/config/models/setup"].includes(
        params.route,
      )
    )
      return false;
    params.response.setHeader("cache-control", "no-store");
    try {
      if (
        params.route === "runtime/config/models/setup" &&
        params.method === "GET"
      ) {
        sendJson(params.response, 200, {
          ok: true,
          ...(await this.service.catalog()),
        });
      } else if (
        params.route === "runtime/config/models" &&
        ["POST", "DELETE"].includes(params.method)
      ) {
        assertConfigMutationRequest(params.request);
        const body = readJsonBody(
          await readBody(params.request, { maxBytes: 16_384 }),
        );
        sendJson(params.response, 200, {
          ok: true,
          ...(params.method === "DELETE"
            ? await this.service.remove(body)
            : await this.service.add(body)),
        });
      } else
        sendJson(params.response, 405, {
          ok: false,
          error: "method_not_allowed",
        });
    } catch (error) {
      const known =
        error instanceof ModelSetupError ||
        error instanceof ConfigMutationRequestError;
      sendJson(params.response, known ? error.statusCode : 400, {
        ok: false,
        error:
          error instanceof ModelSetupError ? error.code : "model_setup_failed",
        message: known
          ? error.message
          : "Model configuration could not be completed. Check the settings and try again.",
        credentialSaved:
          error instanceof ModelSetupError && error.credentialSaved,
      });
    }
    return true;
  }
}
