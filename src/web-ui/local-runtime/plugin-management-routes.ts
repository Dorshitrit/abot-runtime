import { PluginConfigurationRoutes } from "./plugin-configuration-routes.js";
import { PluginRemovalRoutes } from "./plugin-removal-routes.js";
import type { PluginRemovalRuntime } from "../plugin-removal-service.js";
import { PluginInstallationRoutes } from "./plugin-installation-routes.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  getRuntimePluginSnapshot,
  PluginManagementError,
  setRuntimePluginEnabled,
} from "../plugin-management-service.js";
import { sendJson } from "./http.js";

export class PluginManagementRoutes {
  private readonly configuration: PluginConfigurationRoutes;
  private readonly removal: PluginRemovalRoutes;
  private readonly installation: PluginInstallationRoutes;
  constructor(
    private readonly options: {
      rootDir: string;
      requireMutationIdle?: () => void;
      removalRuntime?: PluginRemovalRuntime;
      getConfigPath?: () => string | undefined;
    },
  ) {
    this.configuration = new PluginConfigurationRoutes(options);
    this.removal = new PluginRemovalRoutes(options);
    this.installation = new PluginInstallationRoutes(options);
  }

  async handle(params: {
    method: string;
    route: string;
    body: Record<string, unknown> | null;
    request?: IncomingMessage;
    response: ServerResponse;
  }): Promise<boolean> {
    if (await this.configuration.handle(params)) return true;
    if (await this.installation.handle(params)) return true;
    if (await this.removal.handle(params)) return true;
    if (params.route !== "runtime/plugins") return false;
    const options = {
      rootDir: this.options.rootDir,
      configPath: this.options.getConfigPath?.(),
      requireMutationIdle: this.options.requireMutationIdle,
    };
    try {
      if (params.method === "GET") {
        sendJson(params.response, 200, {
          ok: true,
          ...getRuntimePluginSnapshot(options),
        });
        return true;
      }
      if (params.method === "PUT") {
        this.options.requireMutationIdle?.();
        const result = await setRuntimePluginEnabled(options, params.body);
        sendJson(params.response, 200, { ok: true, ...result });
        return true;
      }
      sendJson(params.response, 405, {
        ok: false,
        error: "method_not_allowed",
      });
    } catch (error) {
      if (error instanceof PluginManagementError) {
        sendJson(params.response, error.statusCode, {
          ok: false,
          error: error.code,
          message: error.message,
        });
        return true;
      }
      sendJson(params.response, 500, {
        ok: false,
        error: "plugin_management_failed",
        message: "Plugin configuration could not be loaded or saved.",
      });
    }
    return true;
  }
}
