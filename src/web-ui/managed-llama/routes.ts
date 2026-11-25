import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { assertConfigMutationRequest, ConfigMutationRequestError } from "../local-runtime/config-mutation-request.js";
import { isLocalNativeFileRequest } from "../local-runtime/conversation-file-native-request.js";
import { readBody, readJsonBody, sendJson } from "../local-runtime/http.js";
import { ManagedLlamaError, type LaunchSettings } from "./contracts.js";
import type { ManagedLlamaService } from "./service.js";

const BASE = "runtime/managed-llama";
const ACTIONS = ["inspect", "install", "start", "stop", "cancel"] as const;
const ROUTES = new Set([BASE, BASE + "/status", ...ACTIONS.map(action => BASE + "/" + action)]);
const ERRORS = new Map<string, number>([
  ["closed", 409], ["busy", 409], ["unsupported_platform", 501],
  ["cancelled", 409], ["storage_unavailable", 503], ["storage_conflict", 409],
  ["persistence_unavailable", 503],
  ["install_failed", 502], ["inspection_failed", 500], ["start_failed", 500],
  ["invalid_launch", 400], ["not_installed", 409], ["installation_unavailable", 503],
  ["port_unavailable", 409], ["spawn_failed", 500], ["readiness_failed", 502],
  ["readiness_timeout", 504], ["child_exited", 502], ["child_error", 502],
  ["start_cancelled", 409], ["termination_unconfirmed", 503], ["stop_failed", 500],
]);
class InputError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
function invalid(): never { throw new InputError(400, "invalid_action_input"); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function validateInput(value: unknown, start: boolean): LaunchSettings | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (!start) { if (keys.length !== 0) invalid(); return undefined; }
  const allowed = ["modelPath", "port", "alias", "contextTokens", "gpuLayers"];
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) return invalid();
  const { modelPath, port, alias, contextTokens, gpuLayers } = input;
  if (typeof modelPath !== "string" || !modelPath.length || modelPath.length > 4096 ||
      !isAbsolute(modelPath) || /[\u0000-\u001f\u007f]/u.test(modelPath) || !modelPath.toLowerCase().endsWith(".gguf") ||
      typeof alias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias) ||
      !integer(port, 1024, 65535) || !integer(contextTokens, 512, 131072) || !integer(gpuLayers, 0, 999)) return invalid();
  // Disk validation remains in the service/lifecycle, not in this transport.
  return { modelPath, port, alias, contextTokens, gpuLayers };
}
async function body(request: IncomingMessage): Promise<unknown> {
  let raw: Buffer;
  try {
    raw = await readBody(request, { maxBytes: 16_384 });
  } catch (error) {
    // Preserve input failure classification, never dependency messages or paths.
    const oversized = error instanceof Error && error.message === "request_body_too_large";
    throw new InputError(oversized ? 413 : 400, oversized ? "body_too_large" : "invalid_request_body");
  }
  if (!raw.toString("utf8").trim()) throw new InputError(400, "invalid_request_body");
  try { return readJsonBody(raw); }
  catch { throw new InputError(400, "invalid_request_body"); }
}

/** Transport only. The application injects and closes the single service owner.
 * No global request queue: cancel/stop can reach the owner while another request
 * awaits installation or readiness. No credentials or configuration persistence.
 */
export class ManagedLlamaRoutes {
  constructor(private readonly service: ManagedLlamaService) {}

  async handle(params: {
    method: string; route: string; request: IncomingMessage; response: ServerResponse;
  }): Promise<boolean> {
    const { method, route, request, response } = params;
    if (!ROUTES.has(route)) return false;
    response.setHeader("cache-control", "no-store");
    try {
      if (!isLocalNativeFileRequest(request)) {
        throw new InputError(403, "local_request_required");
      }
      const statusRoute = route === BASE || route === BASE + "/status";
      if ((statusRoute && method !== "GET") || (!statusRoute && method !== "POST")) {
        response.setHeader("allow", statusRoute ? "GET" : "POST");
        throw new InputError(405, "method_not_allowed");
      }
      if (statusRoute) {
        sendJson(response, 200, { ok: true, capabilities: this.service.capabilities(), status: this.service.status() });
        return true;
      }
      assertConfigMutationRequest(request);
      const input = validateInput(await body(request), route === BASE + "/start");
      switch (route) {
        case BASE + "/inspect": await this.service.refreshStatus(); break;
        case BASE + "/install": await this.service.install(); break;
        case BASE + "/start": await this.service.start(input!); break;
        case BASE + "/stop": await this.service.stop(); break;
        case BASE + "/cancel": await this.service.cancel(); break;
        default: throw new InputError(404, "unknown_action");
      }
      // Discard action return values; only the nonsecret status contract is public.
      sendJson(response, 200, { ok: true, status: this.service.status() });
    } catch (error) {
      let status = 500;
      let code = "managed_llama_failed";
      let message = "The managed llama.cpp operation could not be completed.";
      if (error instanceof InputError) {
        status = error.statusCode; code = error.code;
        message = "The request is not permitted or its input is invalid.";
      } else if (error instanceof ConfigMutationRequestError) {
        status = error.statusCode === 415 ? 415 : 403;
        code = "configuration_request_rejected";
        message = "This operation requires a same-origin JSON request.";
      } else if (error instanceof ManagedLlamaError && ERRORS.has(error.code)) {
        status = ERRORS.get(error.code)!; code = error.code;
      }
      // Codes and messages come only from bounded local constants, never errors.
      sendJson(response, status, { ok: false, error: code, message });
    }
    return true;
  }
}
