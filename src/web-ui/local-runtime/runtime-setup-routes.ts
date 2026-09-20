import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertConfigMutationRequest,
  ConfigMutationRequestError,
} from "./config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "./http.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import { RuntimeSetupService } from "./runtime-setup-service.js";

export class RuntimeSetupRoutes {
  constructor(private readonly service: RuntimeSetupService) {}

  status() {
    return this.service.status();
  }

  finalize(connectionRevision?: string): Promise<boolean> {
    return this.service.finalize(connectionRevision);
  }

  async handle(params: {
    method: string;
    route: string;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    if (params.route !== "runtime/setup") return false;
    params.response.setHeader("cache-control", "no-store");
    try {
      if (params.method === "GET") {
        sendJson(params.response, 200, {
          ok: true,
          setup: await this.service.status(),
        });
        return true;
      }
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
      sendJson(params.response, 200, {
        ok: true,
        ...(await this.service.save(body)),
      });
    } catch (error) {
      const isPublicError =
        error instanceof RuntimeSetupError ||
        error instanceof ConfigMutationRequestError;
      sendJson(params.response, isPublicError ? error.statusCode : 400, {
        ok: false,
        error:
          error instanceof RuntimeSetupError
            ? error.code
            : "runtime_setup_failed",
        message: isPublicError
          ? error.message
          : "Setup could not be saved. Check the existing configuration and file access, then try again.",
      });
    }
    return true;
  }
}
