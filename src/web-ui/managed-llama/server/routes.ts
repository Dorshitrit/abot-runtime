import type { IncomingMessage, ServerResponse } from "node:http";
import { assertConfigMutationRequest, ConfigMutationRequestError } from "../../local-runtime/config-mutation-request.js";
import { isLocalNativeFileRequest } from "../../local-runtime/conversation-file-native-request.js";
import { readBody, readJsonBody, sendJson } from "../../local-runtime/http.js";
import { ManagedLlamaError } from "../contracts.js";
import { discoverOllamaModels, inspectModelCandidate } from "./catalog.js";
import { serverAlias, serverFailure, serverPath } from "./settings.js";
import type { ManagedLlamaServerManager } from "./manager.js";

const BASE = "runtime/managed-llama/server";
const actions = new Set(["install", "inspect", "configure", "start", "stop", "discover", "inspect-model"]);
function exact(body: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key)))
    throw serverFailure("invalid_server_settings");
}
export class ManagedLlamaServerRoutes {
  constructor(private readonly manager: ManagedLlamaServerManager) {}
  async handle({ method, route, request, response }: {
    method: string; route: string; request: IncomingMessage; response: ServerResponse;
  }): Promise<boolean> {
    if (route !== BASE && !route.startsWith(BASE + "/")) return false;
    response.setHeader("cache-control", "no-store");
    try {
      if (!isLocalNativeFileRequest(request)) { sendJson(response, 403, { ok: false, error: "local_request_required" }); return true; }
      if (route === BASE && method === "GET") {
        await this.manager.observe();
        sendJson(response, 200, { ok: true, server: this.manager.status() });
        return true;
      }
      const action = route.slice(BASE.length + 1);
      if (method !== "POST" || !actions.has(action)) { sendJson(response, 405, { ok: false, error: "method_not_allowed" }); return true; }
      assertConfigMutationRequest(request);
      const body = readJsonBody(await readBody(request, { maxBytes: 1_048_576 }));
      if (action === "configure") {
        exact(body, ["settings", "revision"]);
        if (body.revision !== null && (typeof body.revision !== "string" || !/^[a-f0-9]{32}$/u.test(body.revision))) throw serverFailure("invalid_server_settings");
        await this.manager.configure(body.settings, body.revision as string | null);
      } else if (action === "discover") {
        exact(body, [], ["directory"]);
        const directory = body.directory === undefined ? undefined : serverPath(body.directory);
        sendJson(response, 200, { ok: true, ...await discoverOllamaModels(directory) });
        return true;
      } else if (action === "inspect-model") {
        exact(body, ["modelPath", "alias"], ["templatePath", "projectorPath"]);
        const input = { modelPath: serverPath(body.modelPath), alias: serverAlias(body.alias),
          ...(body.templatePath === undefined ? {} : { templatePath: serverPath(body.templatePath) }),
          ...(body.projectorPath === undefined ? {} : { projectorPath: serverPath(body.projectorPath) }) };
        sendJson(response, 200, { ok: true, candidate: await inspectModelCandidate(input) });
        return true;
      } else {
        exact(body, []);
        switch (action) {
          case "install": await this.manager.install(); break;
          case "inspect": await this.manager.inspect(); break;
          case "start": await this.manager.start(); break;
          case "stop": await this.manager.stop(); break;
        }
      }
      sendJson(response, 200, { ok: true, server: this.manager.status() });
    } catch (error) {
      const configurationError = error instanceof ConfigMutationRequestError;
      const code = error instanceof ManagedLlamaError ? error.code : "managed_server_failed";
      const conflict = ["busy", "server_state_busy", "server_settings_changed", "port_unavailable", "not_installed"].includes(code);
      sendJson(response, configurationError ? error.statusCode : conflict ? 409 : 400,
        { ok: false, error: configurationError ? "configuration_request_rejected" : code,
          message: "The local llama.cpp server operation could not be completed. Refresh its status before retrying." });
    }
    return true;
  }
}
