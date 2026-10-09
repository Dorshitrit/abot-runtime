import type { IncomingMessage, ServerResponse } from "node:http";
import { PluginConfigurationError } from "../../runtime/plugins/configuration-store.js";
import {
  getRuntimePluginConfiguration,
  saveRuntimePluginConfiguration,
} from "../plugin-configuration-service.js";
import { PluginManagementError } from "../plugin-management-service.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

export class PluginConfigurationRoutes {
  constructor(
    private readonly options: {
      rootDir: string;
      requireMutationIdle?: () => void;
      getConfigPath?: () => string | undefined;
    },
  ) {}

  async handle(params: {
    method: string;
    route: string;
    body: Record<string, unknown> | null;
    request?: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    const prefix = "runtime/plugins/configuration/";
    if (!params.route.startsWith(prefix)) return false;
    params.response.setHeader("Cache-Control", "no-store");
    try {
      const pluginId = decodeURIComponent(params.route.slice(prefix.length));
      const options = {
        ...this.options,
        configPath: this.options.getConfigPath?.(),
      };
      if (params.method === "GET") {
        sendJson(params.response, 200, {
          ok: true,
          configuration: getRuntimePluginConfiguration(options, pluginId),
        });
        return true;
      }
      if (params.method !== "PUT") {
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
      const saved = await saveRuntimePluginConfiguration(options, {
        pluginId,
        input: params.body,
      });
      sendJson(params.response, 200, {
        ok: true,
        configuration: saved.configuration,
        restartRequired: true,
      });
    } catch (error) {
      const known =
        error instanceof PluginConfigurationError ||
        error instanceof PluginManagementError;
      sendJson(params.response, known ? error.statusCode : 500, {
        ok: false,
        error: known ? error.code : "plugin_configuration_failed",
        message: known
          ? error.message
          : "Plugin configuration could not be loaded or saved.",
      });
    }
    return true;
  }
}
