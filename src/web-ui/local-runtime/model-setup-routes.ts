import { createManagedLlamaHandoff, type ConfigurationHandoff } from "../managed-llama/configuration-handoff.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertConfigMutationRequest,
  ConfigMutationRequestError,
} from "./config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "./http.js";
import { modelSetupContextWindowErrorDetails } from "./model-setup-context-window.js";
import { ModelSetupError } from "./model-setup-input.js";
import { ModelSetupService } from "./model-setup-service.js";

export class ModelSetupRoutes {
  constructor(
    private readonly service: ModelSetupService,
    private readonly resolveSaveInput: ConfigurationHandoff = createManagedLlamaHandoff("models"),
  ) {}

  private selectMutation(method: string, route: string) {
    switch (`${method} ${route}`) {
      case "POST runtime/config/models":
        return (body: Record<string, unknown>) => this.service.add(this.resolveSaveInput(body));
      case "DELETE runtime/config/models":
        return this.service.remove.bind(this.service);
      case "PUT runtime/config/providers":
        return this.service.updateProvider.bind(this.service);
      case "DELETE runtime/config/providers":
        return this.service.removeProvider.bind(this.service);
    }
  }

  async handle(params: {
    method: string;
    route: string;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    if (
      ![
        "runtime/config/models",
        "runtime/config/models/setup",
        "runtime/config/providers",
      ].includes(params.route)
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
        return true;
      }
      const mutate = this.selectMutation(params.method, params.route);
      if (!mutate) {
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
      sendJson(params.response, 200, { ok: true, ...(await mutate(body)) });
    } catch (error) {
      const known =
        error instanceof ModelSetupError ||
        error instanceof ConfigMutationRequestError;
      sendJson(params.response, known ? error.statusCode : 400, {
        ok: false,
        ...modelSetupContextWindowErrorDetails(error),
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
