import type { IncomingMessage, ServerResponse } from "node:http";
import { isHostRecord } from "../../computer-access/companion/protocol.js";
import { isNativePermissionEnvironment, readNativePermissionInput, type NativePermissionClient, type NativePermissionStatus } from "../../computer-access/native-permission-contract.js";
import { sendJson } from "../local-runtime/http.js";
import { hasLocalRuntimeRequestAuthority } from "./local-request-authority.js";

export type NativePermissionAccess = (environmentId: string) => NativePermissionClient | undefined;

export function isNativeRuntimePermissionRequest(value: unknown): value is Record<string, unknown> {
  return isHostRecord(value) && value.scope === "native_runtime";
}

/** Browser management binds to a running environment owner; it never starts one. */
export class NativeRuntimePermissionRoute {
  constructor(
    private readonly clients: NativePermissionAccess = () => undefined,
    private readonly platform = process.platform,
  ) {}

  private unavailableReason(request: IncomingMessage): string | undefined {
    if (this.platform !== "darwin") return "native_macos_unavailable";
    if (!hasLocalRuntimeRequestAuthority(request)) return "local_browser_required";
    return undefined;
  }

  private hasCurrentOwner(environmentId: string, client: NativePermissionClient, status: NativePermissionStatus, ownerId: string): boolean {
    if (!status.available) return false;
    if (status.ownerId !== ownerId) return false;
    return this.clients(environmentId) === client;
  }

  async status(request: IncomingMessage) {
    const environmentId = new URL(request.url ?? "/", "http://localhost").searchParams.get("environment") ?? "";
    const binding = { scope: "native_runtime" as const, environmentId };
    const unavailable = this.unavailableReason(request);
    if (unavailable) return { ...binding, available: false, reason: unavailable };
    if (!isNativePermissionEnvironment(environmentId)) return { ...binding, available: false, reason: "runtime_not_started" };
    const client = this.clients(environmentId);
    if (!client) return { ...binding, available: false, reason: "runtime_not_started" };
    try {
      const status = await client.status();
      if (this.clients(environmentId) !== client) return { ...binding, available: false, reason: "runtime_owner_unavailable" };
      return { ...binding, ...status };
    } catch { return { ...binding, available: false, reason: "runtime_owner_unavailable" }; }
  }

  async handle(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const { scope, environmentId, ...fields } = body;
    const input = readNativePermissionInput(fields);
    if (scope !== "native_runtime" || !isNativePermissionEnvironment(environmentId) || !input) {
      sendJson(response, 400, { ok: false, error: "macos_permissions_input_invalid" });
      return;
    }
    const unavailable = this.unavailableReason(request);
    if (unavailable) {
      sendJson(response, 409, { ok: false, error: unavailable, message: "Prepare native permissions from this Mac's local ABot page." });
      return;
    }
    const client = this.clients(environmentId);
    if (!client) {
      sendJson(response, 409, { ok: false, error: "runtime_not_started", message: "Start the selected Runtime environment, then check its native permissions." });
      return;
    }
    try {
      const status = await client.status();
      if (response.destroyed) return;
      if (!this.hasCurrentOwner(environmentId, client, status, input.ownerId))
        throw new Error("macos_permissions_owner_changed");
      const result = await client.prepare(input);
      if (response.destroyed) return;
      if (this.clients(environmentId) !== client) throw new Error("macos_permissions_owner_changed");
      sendJson(response, 200, { ok: true, scope, environmentId, ...result });
    } catch (error) {
      if (response.destroyed) return;
      const code = error instanceof Error ? error.message : "macos_permissions_check_failed";
      if (code === "macos_permissions_owner_changed") {
        sendJson(response, 409, { ok: false, error: code, message: "The native Runtime owner changed. Refresh and check its permissions again." });
        return;
      }
      if (code === "macos_permissions_busy") {
        sendJson(response, 409, { ok: false, error: code, message: "A permission check or request is already in progress for this Runtime." });
        return;
      }
      sendJson(response, 503, { ok: false, error: "macos_permissions_check_failed", message: "Native permission preparation did not complete. Check the running Runtime and Swift developer tools. Any macOS permission prompt already opened is not revoked." });
    }
  }
}
