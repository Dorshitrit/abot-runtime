import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalRuntimeApplication } from "../../runtime/local-application.js";
import { assertConfigMutationRequest, ConfigMutationRequestError } from "./config-mutation-request.js";
import { readBody, readJsonBody, requestEnvironmentId, sendJson } from "./http.js";
import { isLocalSocketConnectionRequest } from "./socket-connection-authority.js";

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  socket_connection_bundle_invalid: "Choose the private connection file created by ABot Socket setup.",
  socket_connection_binding_confirmation_required: "Confirm which local environment this computer will share.",
  socket_connection_binding_in_use: "This Socket identity is already linked to another local environment. Forget that connection before moving it.",
  socket_connection_busy: "This connection has work in progress. Wait for it to finish before pausing, replacing or forgetting the connection.",
  socket_connection_input_invalid: "Check the connection details and try again.",
  socket_connection_activation_failed: "The connection was saved but could not start. Refresh its status and try again.",
  socket_connection_not_configured: "Connect this computer to ABot Socket first.",
  socket_connection_revision_conflict: "The connection changed in another window. Refresh its status before trying again.",
  socket_connection_conflict: "The connection changed in another window. Refresh its status before trying again.",
  socket_connection_store_unavailable: "The saved connection could not be accessed. Check local file access and try again.",
  local_runtime_connection_lost: "The Runtime connection was lost. Refresh its status before trying again.",
  local_runtime_owner_busy: "The Runtime is changing configuration. Wait for it to finish, then try again.",
};

type ConnectionClient = LocalRuntimeApplication["socketConnection"];
const actions = new Set(["preview", "connect", "pause", "resume", "forget"]);

/** HTTP is a local, bounded adapter; persistence and connection decisions belong to Runtime. */
export class SocketConnectionRoutes {
  constructor(
    private readonly client: (environmentId: string) => ConnectionClient,
    private readonly defaultEnvironment: () => string,
    private readonly allowPublishedLoopback = false,
  ) {}

  async handle(route: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (route !== "socket-connection" && !route.startsWith("socket-connection/")) return false;
    response.setHeader("cache-control", "no-store");
    if (!isLocalSocketConnectionRequest(request, this.allowPublishedLoopback)) {
      sendJson(response, 403, { ok: false, error: "socket_connection_local_only", message: "Manage this connection from the Runtime computer." });
      return true;
    }
    const action = route.slice("socket-connection/".length);
    const method = request.method ?? "GET";
    const isRead = route === "socket-connection" && method === "GET";
    if (!isRead && (method !== "POST" || !actions.has(action))) {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    try {
      if (!isRead) assertConfigMutationRequest(request);
      const body = isRead ? null : readJsonBody(await readBody(request, { maxBytes: 16_384 }));
      const url = new URL(request.url ?? "/", "http://localhost");
      const environmentId = requestEnvironmentId(url, body, this.defaultEnvironment());
      const client = this.client(environmentId);
      if (isRead) {
        sendJson(response, 200, { ok: true, connection: await client.status() });
        return true;
      }
      if (action === "preview") {
        sendJson(response, 200, { ok: true, preview: await client.preview(body?.bundle) });
        return true;
      }
      const expectedRevision = body?.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
        sendJson(response, 400, { ok: false, error: "socket_connection_revision_required", message: "Refresh the connection status before changing it." });
        return true;
      }
      const input = { expectedRevision: expectedRevision as number };
      if (action === "connect") {
        const connection = await client.import({ ...input, bundle: body?.bundle, confirmBinding: body?.confirmBinding === true });
        sendJson(response, 200, { ok: true, connection });
        return true;
      }
      const command = action as "pause" | "resume" | "forget";
      sendJson(response, 200, { ok: true, connection: await client[command](input) });
    } catch (error) {
      if (error instanceof ConfigMutationRequestError) {
        sendJson(response, error.statusCode, { ok: false, error: "configuration_request_rejected", message: "Connection changes require same-origin JSON requests." });
        return true;
      }
      const code = error instanceof Error ? error.message : "";
      if (code === "request_body_too_large") {
        sendJson(response, 413, { ok: false, error: "socket_connection_bundle_too_large", message: "This connection file is too large." });
        return true;
      }
      const known = Object.hasOwn(FAILURE_MESSAGES, code);
      sendJson(response, known ? 409 : 400, { ok: false,
        error: known ? code : "socket_connection_failed",
        message: FAILURE_MESSAGES[code] ?? "The connection could not be updated. Check the connection file and refresh its status.",
      });
    }
    return true;
  }
}
