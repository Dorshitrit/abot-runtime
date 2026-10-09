import { ConfigFileConflictError } from "../../runtime/adapters/config-file-transaction.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PluginRemovalActivationError } from "../plugin-removal-error.js";
import { PluginManagementError } from "../plugin-management-service.js";
import {
  removeRuntimePlugin,
  type PluginRemovalRuntime,
} from "../plugin-removal-service.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

export class PluginRemovalRoutes {
  constructor(
    private readonly options: {
      rootDir: string;
      requireMutationIdle?: () => void;
      getConfigPath?: () => string | undefined;
      removalRuntime?: PluginRemovalRuntime;
    },
  ) {}

  async handle(params: {
    method: string;
    route: string;
    body: Record<string, unknown> | null;
    request?: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    if (params.route !== "runtime/plugins/remove") return false;
    if (params.method !== "POST") {
      sendJson(params.response, 405, {
        ok: false,
        error: "method_not_allowed",
      });
      return true;
    }
    if (!params.request) {
      sendJson(params.response, 403, {
        ok: false,
        error: "request_origin_required",
      });
      return true;
    }
    if (!acceptConfigMutationRequest(params.request, params.response))
      return true;
    try {
      if (!this.options.removalRuntime)
        throw new PluginManagementError(
          "plugin_removal_unavailable",
          "This Runtime cannot apply plugin removal.",
          409,
        );
      this.options.requireMutationIdle?.();
      const result = await removeRuntimePlugin(
        {
          rootDir: this.options.rootDir,
          requireMutationIdle: this.options.requireMutationIdle,
          configPath: this.options.getConfigPath?.(),
          ...this.options.removalRuntime,
        },
        params.body,
      );
      sendJson(params.response, 200, { ok: true, ...result });
    } catch (error) {
      const known =
        error instanceof PluginManagementError ||
        error instanceof ConfigFileConflictError;
      const status =
        error instanceof PluginManagementError ? error.statusCode : 500;
      sendJson(
        params.response,
        error instanceof ConfigFileConflictError ? 409 : status,
        {
          ok: false,
          ...(error instanceof PluginRemovalActivationError
            ? { activation: error.activation }
            : {}),
          error: known ? error.code : "plugin_removal_failed",
          message: known
            ? error.message
            : "Plugin removal could not complete. Refresh plugins before trying again.",
        },
      );
    }
    return true;
  }
}
