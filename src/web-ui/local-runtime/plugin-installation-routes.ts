import { projectPluginConfiguration } from "../plugin-configuration-view.js";
import { saveRuntimePluginConfiguration } from "../plugin-configuration-service.js";
import {
  PluginConfigurationError,
  readPluginConfigurationStore,
} from "../../runtime/plugins/configuration-store.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PluginInstallError } from "../../plugin-contract/install-source.js";
import {
  inspectPluginPackage,
  installPluginPackage,
} from "../../runtime/plugins/installation/service.js";
import { inspectRuntimeConfigFileWithMeta } from "../../runtime/config/loader.js";
import {
  PluginManagementError,
  setRuntimePluginEnabled,
} from "../plugin-management-service.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

export class PluginInstallationRoutes {
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
    if (
      !["runtime/plugins/inspect", "runtime/plugins/install"].includes(
        params.route,
      )
    )
      return false;
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
      const configPath = this.options.getConfigPath?.();
      const configuration = inspectRuntimeConfigFileWithMeta(
        this.options.rootDir,
        configPath,
      );
      if (!configuration.exists)
        throw new PluginInstallError(
          "runtime_setup_required",
          "Complete Runtime setup before installing plugins.",
          409,
        );
      if (params.route === "runtime/plugins/inspect") {
        const review = await inspectPluginPackage(
          this.options.rootDir,
          params.body,
        );
        const configuration = projectPluginConfiguration(
          review.id,
          {
            settings: { defaults: review.settings },
            secrets: Object.fromEntries(
              review.secrets.map(({ name, env, required }) => [
                name,
                { env, required },
              ]),
            ),
          },
          readPluginConfigurationStore(this.options.rootDir),
        );
        sendJson(params.response, 200, {
          ok: true,
          review: { ...review, configuration },
        });
        return true;
      }
      this.options.requireMutationIdle?.();
      const result = await installPluginPackage({
        requireMutationIdle: this.options.requireMutationIdle,
        rootDir: this.options.rootDir,
        configPath: configuration.path,
        input: params.body,
        saveSelection: async (pluginId, transaction) => {
          const options = {
            rootDir: this.options.rootDir,
            configPath,
            requireMutationIdle: this.options.requireMutationIdle,
          };
          const saved = await saveRuntimePluginConfiguration(options, {
            pluginId,
            input: params.body?.configuration,
            transaction,
            installation: true,
            commit: () =>
              setRuntimePluginEnabled(
                options,
                { pluginId, enabled: true },
                transaction,
              ),
          });
          return saved.result!;
        },
      });
      sendJson(params.response, 200, {
        ok: true,
        ...result.snapshot,
        installed: result.installed,
      });
    } catch (error) {
      const known =
        error instanceof PluginConfigurationError ||
        error instanceof PluginInstallError ||
        error instanceof PluginManagementError;
      sendJson(params.response, known ? error.statusCode : 500, {
        ok: false,
        error: known ? error.code : "plugin_installation_failed",
        message: known
          ? error.message
          : "The plugin could not be installed. No existing plugin was replaced.",
      });
    }
    return true;
  }
}
