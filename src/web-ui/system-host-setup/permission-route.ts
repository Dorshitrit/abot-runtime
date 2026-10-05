import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostConnection } from "../../computer-access/companion/connection.js";
import { isHostIdentifier, isHostRecord } from "../../computer-access/companion/protocol.js";
import {
  isMacPermissionAction,
  MACOS_PERMISSION_CAPABILITY,
  MACOS_PERMISSION_OPERATION,
  readMacPermissionResult,
  type MacPermissionAction,
} from "../../computer-access/companion/permission-protocol.js";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "../local-runtime/http.js";
import { isNativeRuntimePermissionRequest, type NativeRuntimePermissionRoute } from "./native-permission-route.js";

export const HOST_PERMISSION_PATH = "/web-api/runtime/system-host/permissions";
type PermissionInput = MacPermissionAction & { hostId: string; connectionId: string };

function readPermissionInput(value: unknown): PermissionInput | undefined {
  if (!isHostRecord(value)) return undefined;
  const { hostId, connectionId, ...action } = value;
  if (!isHostIdentifier(hostId)) return undefined;
  if (!isHostIdentifier(connectionId)) return undefined;
  if (!isMacPermissionAction(action)) return undefined;
  return { hostId, connectionId, ...action };
}

/** User-only setup endpoint; permission actions are never exposed as model tools. */
export class HostPermissionRoute {
  private busy = false;
  constructor(
    private readonly connection: Pick<HostConnection, "status" | "execute">,
    private readonly native?: NativeRuntimePermissionRoute,
  ) {}

  private hasCurrentMacBinding(input: PermissionInput): boolean {
    const status = this.connection.status();
    if (!status.connected) return false;
    if (status.identity?.os !== "macos") return false;
    if (status.hostId !== input.hostId) return false;
    return status.connectionId === input.connectionId;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!acceptConfigMutationRequest(request, response)) return;
    let input: PermissionInput | undefined;
    let body: unknown;
    try {
      const raw = await readBody(request, { maxBytes: 1024 });
      body = JSON.parse(raw.toString());
      input = readPermissionInput(body);
    } catch { /* malformed or oversized input is rejected before dispatch */ }
    if (isNativeRuntimePermissionRequest(body) && this.native) {
      await this.native.handle(request, response, body);
      return;
    }
    if (!input) {
      sendJson(response, 400, { ok: false, error: "macos_permissions_input_invalid" });
      return;
    }
    if (!this.hasCurrentMacBinding(input)) {
      sendJson(response, 409, { ok: false, error: "macos_permissions_host_changed", message: "Refresh Computer access and check the current Mac connection." });
      return;
    }
    if (!this.connection.status().capabilities?.includes(MACOS_PERMISSION_CAPABILITY)) {
      sendJson(response, 409, { ok: false, error: "macos_permissions_update_required", message: "Update this Mac connection before preparing its permissions." });
      return;
    }
    if (this.busy) {
      sendJson(response, 409, { ok: false, error: "macos_permissions_busy", message: "A permission check or request is already in progress." });
      return;
    }
    this.busy = true;
    const stop = new AbortController();
    const timeout = setTimeout(() => stop.abort(), 50_000);
    const disconnected = () => { if (!response.writableEnded) stop.abort(); };
    response.once("close", disconnected);
    try {
      const { hostId, connectionId, ...action } = input;
      const result = await this.connection.execute({
        hostId, connectionId, operation: MACOS_PERMISSION_OPERATION,
        params: { target: "macos", ...action }, abortSignal: stop.signal,
      });
      if (!this.hasCurrentMacBinding(input)) {
        sendJson(response, 409, { ok: false, error: "macos_permissions_host_changed", message: "The Mac connection changed. Check its permissions again." });
        return;
      }
      const permissionResult = result.ok ? readMacPermissionResult(result.data) : undefined;
      if (!permissionResult) {
        sendJson(response, 503, { ok: false, error: "macos_permissions_check_failed", message: "Permission preparation did not complete. Check the Mac connection and Swift developer tools, then check again." });
        return;
      }
      sendJson(response, 200, { ok: true, hostId, connectionId, scope: "companion", ...permissionResult });
    } finally {
      clearTimeout(timeout);
      response.removeListener("close", disconnected);
      this.busy = false;
    }
  }
}
