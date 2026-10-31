import { randomUUID } from "node:crypto";
import type { RuntimeSessionsResetResult } from "../../runtime/local-host/maintenance-contracts.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeEnvironment } from "./contracts.js";
import type { WebSessionReadStates } from "../session-read-state/service.js";
import type { RuntimeSessionResetNotice, WorkspaceChangeNotifier } from "./workspace-notifications.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

const MESSAGES: Readonly<Record<string, string>> = {
  runtime_maintenance_busy: "The Runtime is working. Wait for active conversations and Jobs to finish, then try again.",
  runtime_maintenance_pending_approvals: "Resolve or cancel pending approvals before deleting conversations.",
  runtime_maintenance_scope_unavailable: "The Runtime cannot verify the storage scope from its configuration. Apply the current configuration before trying again; custom configuration hosts must provide the same configuration file to the Runtime owner.",
  runtime_maintenance_shared_paths: "This storage is shared with another environment. Give each environment separate paths before resetting it.",
  runtime_log_reset_unsafe_path: "The log location contains a link or an unexpected file. Logs were not fully cleared.",
  runtime_maintenance_unavailable: "This Runtime does not support maintenance.",
  local_runtime_connection_lost: "The Runtime connection was lost. The result is unknown; refresh before trying again.",
};

type MaintenanceRouteInput = Readonly<{
  method: string;
  route: string;
  body: Record<string, unknown> | null;
  environmentId: string;
  request: IncomingMessage;
  response: ServerResponse;
}>;

function isRuntimeMaintenanceRoute(route: string): boolean {
  return route === "runtime/maintenance/sessions" || route === "runtime/maintenance/logs";
}

function hasConfirmedMaintenanceRequest(body: Record<string, unknown> | null): boolean {
  if (body?.confirmed !== true) return false;
  return Object.keys(body).every(key => ["confirmed", "environment", "environmentId"].includes(key));
}

export class RuntimeMaintenanceRoutes {
  constructor(
    private readonly resolveEnvironment: (environmentId: string) => RuntimeEnvironment,
    private readonly readStates: Pick<WebSessionReadStates, "resetConversations">,
    private readonly notifyChanged?: WorkspaceChangeNotifier,
    private readonly withClientStateReset: (environmentId: string, operation: () => Promise<RuntimeSessionsResetResult>) => Promise<RuntimeSessionsResetResult> = (_id, operation) => operation(),
  ) {}

  async handle(input: MaintenanceRouteInput): Promise<boolean> {
    if (!isRuntimeMaintenanceRoute(input.route)) return false;
    input.response.setHeader("cache-control", "no-store");
    if (input.method !== "POST") {
      input.response.setHeader("allow", "POST");
      sendJson(input.response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (!acceptConfigMutationRequest(input.request, input.response)) return true;
    if (!hasConfirmedMaintenanceRequest(input.body)) {
      sendJson(input.response, 400, { ok: false, error: "runtime_maintenance_confirmation_required",
        message: "Confirm this reset before continuing." });
      return true;
    }
    try {
      const maintenance = this.resolveEnvironment(input.environmentId).services.maintenance;
      if (input.route === "runtime/maintenance/logs") {
        sendJson(input.response, 200, { ok: true, result: await maintenance.clearLogs() });
        return true;
      }
      let sessionReset: RuntimeSessionResetNotice | undefined;
      try {
        const result = await this.withClientStateReset(input.environmentId, () =>
          this.readStates.resetConversations(input.environmentId, () => maintenance.resetSessions()));
        sessionReset = { ...result, resetId: randomUUID() };
        sendJson(input.response, 200, { ok: true, result: sessionReset });
      } finally {
        this.notifyChanged?.(input.environmentId, ["sessions", "client-state"], sessionReset);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "runtime_maintenance_failed";
      const publicCode = Object.hasOwn(MESSAGES, code) ? code : "runtime_maintenance_failed";
      sendJson(input.response, 409, { ok: false, error: publicCode,
        message: MESSAGES[code] ?? "The reset did not finish. Some data may already have been removed; refresh to review the current state." });
    }
    return true;
  }
}
