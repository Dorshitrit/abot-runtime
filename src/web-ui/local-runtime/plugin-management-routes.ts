import type { ServerResponse } from "node:http";

import {
  getRuntimePluginSnapshot,
  PluginManagementError,
  setRuntimePluginEnabled,
} from "../plugin-management-service.js";
import { sendJson } from "./http.js";

export class PluginManagementRoutes {
  constructor(
    private readonly options: {
      rootDir: string;
      getConfigPath?: () => string | undefined;
    },
  ) {}

  async handle(params: {
    method: string;
    route: string;
    body: Record<string, unknown> | null;
    response: ServerResponse;
  }): Promise<boolean> {
    if (params.route !== "runtime/plugins") return false;
    const options = {
      rootDir: this.options.rootDir,
      configPath: this.options.getConfigPath?.(),
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
