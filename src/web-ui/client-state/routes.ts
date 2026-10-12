import type { IncomingMessage, ServerResponse } from "node:http";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "../local-runtime/http.js";
import { ClientStateError } from "./contracts.js";
import { updatePreference } from "./preferences.js";
import { WebClientStateStore } from "./store.js";
import { changeClientQueue } from "./queue.js";

export class WebClientStateRoutes {
  private readonly store: WebClientStateStore;
  constructor(rootDir: string, private readonly changed: () => void = () => {}) { this.store = new WebClientStateStore(rootDir); }
  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname !== "/web-ui-state") return false;
    response.setHeader("cache-control", "no-store");
    try {
      if (request.method === "GET") {
        const { state } = await this.store.transaction(() => null);
        sendJson(response, 200, { ok: true, state });
        return true;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "method_not_allowed" });
        return true;
      }
      if (!acceptConfigMutationRequest(request, response)) return true;
      const input = readJsonBody(await readBody(request, { maxBytes: 1024 * 1024 }));
      const saved = await this.store.transaction((state) => {
        if (input.kind === "preference") { updatePreference(state.preferences, input); return null; }
        if (input.kind === "queue") return changeClientQueue(state, input);
        if (input.kind === "introduction") { state.introductionSeen = true; return null; }
        throw new ClientStateError("invalid_state_operation", "Unknown workspace state operation.");
      });
      sendJson(response, 200, { ok: true, ...saved });
      try { this.changed(); } catch { /* Persistence already succeeded; clients also refresh on focus. */ }
    } catch (error) {
      const known = error instanceof ClientStateError;
      sendJson(response, known ? error.status : 500, { ok: false,
        error: known ? error.code : "workspace_state_unavailable",
        message: known ? error.message : "Workspace settings could not be saved or loaded. Existing data was preserved. Reload before continuing." });
    }
    return true;
  }
}
