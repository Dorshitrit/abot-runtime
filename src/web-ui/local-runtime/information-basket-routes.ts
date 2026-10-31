import { isBasketMatchMode } from "../../runtime/information-basket/snapshot-validation.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { InformationBasketManagement } from "../../runtime/local-host/client-information-basket.js";
import { BASKET_LIMITS } from "../../runtime/information-basket/limits.js";
import { InformationBasketError } from "../../runtime/information-basket/contracts.js";
import type { JsonObject } from "./contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

type BasketManagementRequest = Readonly<{
  method: string;
  segments: readonly string[];
  url: URL;
  body: JsonObject | null;
  environmentId: string;
  request: IncomingMessage;
  response: ServerResponse;
}>;

/** Web-only management: source registration is an explicit exact-path read grant. */
export class InformationBasketRoutes {
  constructor(private readonly resolveService: (
    environmentId: string,
  ) => InformationBasketManagement | undefined) {}

  async handle(input: BasketManagementRequest): Promise<boolean> {
    const { segments, method, response } = input;
    if (!isBasketRoute(segments)) return false;
    const action = basketRouteAction(segments);
    if (!action) return false;
    const methods: readonly string[] = BASKET_ROUTE_METHODS[action];
    if (!methods.includes(method)) {
      response.setHeader("allow", methods.join(", "));
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    response.setHeader("cache-control", "no-store");
    if (method !== "GET" && !acceptConfigMutationRequest(input.request, response)) return true;
    try {
      const service = this.resolveService(input.environmentId);
      if (!service) throw new InformationBasketError("basket_service_unavailable", undefined, 503);
      const data = await dispatchBasketManagement(service, action, input);
      sendJson(response, method === "POST" && action === "collection" ? 201 : 200, { ok: true, ...data });
    } catch (error) {
      sendBasketManagementError(response, error);
    }
    return true;
  }
}

const BASKET_ROUTE_METHODS = {
  collection: ["GET", "POST"],
  browse: ["GET"],
  settings: ["POST"],
  source: ["DELETE"],
  reindex: ["POST"],
  relink: ["POST"],
} as const satisfies Record<string, readonly string[]>;
type BasketRouteAction = keyof typeof BASKET_ROUTE_METHODS;

function isBasketRoute(segments: readonly string[]): boolean {
  return segments[0] === "runtime" && segments[1] === "information-basket";
}

function basketRouteAction(segments: readonly string[]): BasketRouteAction | undefined {
  if (segments.length === 2) return "collection";
  if (segments.length === 3 && segments[2] === "browse") return "browse";
  if (segments.length === 3 && segments[2] === "settings") return "settings";
  if (segments.length === 3 && segments[2]) return "source";
  if (segments.length === 4 && segments[2] && segments[3] === "reindex") return "reindex";
  if (segments.length === 4 && segments[2] && segments[3] === "relink") return "relink";
  return undefined;
}

async function dispatchBasketManagement(
  service: InformationBasketManagement,
  action: BasketRouteAction,
  input: BasketManagementRequest,
) {
  if (action === "browse") return service.browseFiles({
    path: input.url.searchParams.get("path") ?? undefined,
    cursor: input.url.searchParams.get("cursor") ?? undefined,
  });
  if (action === "collection" && input.method === "GET") return service.list();
  if (action === "collection") {
    const body = requireBasketBody(input.body, ["paths"]);
    if (!hasSourcePaths(body.paths)) throw new InformationBasketError("basket_paths_invalid");
    return service.addSources({ paths: body.paths });
  }
  if (action === "settings") {
    const body = requireBasketBody(input.body, ["expectedRevision", "enabled", "embeddingProfileId", "indexChatUploads", "matchMode"]);
    if (body.indexChatUploads !== undefined && typeof body.indexChatUploads !== "boolean")
      throw new InformationBasketError("basket_settings_invalid");
    if (body.matchMode !== undefined && !isBasketMatchMode(body.matchMode))
      throw new InformationBasketError("basket_settings_invalid");
    if (typeof body.enabled !== "boolean") throw new InformationBasketError("basket_settings_invalid");
    if (body.embeddingProfileId !== null && typeof body.embeddingProfileId !== "string")
      throw new InformationBasketError("basket_profile_invalid");
    return service.updateSettings({
      expectedRevision: readExpectedBasketRevision(body.expectedRevision),
      enabled: body.enabled,
      ...(body.matchMode === undefined ? {} : { matchMode: body.matchMode }),
      ...(body.indexChatUploads === undefined ? {} : { indexChatUploads: body.indexChatUploads }),
      embeddingProfileId: body.embeddingProfileId,
    });
  }
  if (action === "relink") {
    const body = requireBasketBody(input.body, ["expectedRevision", "path"]);
    if (!hasBasketRelinkPath(body.path)) throw new InformationBasketError("basket_path_invalid");
    return service.relinkSource({
      sourceId: input.segments[2]!,
      expectedRevision: readExpectedBasketRevision(body.expectedRevision),
      path: body.path,
    });
  }
  const body = requireBasketBody(input.body, ["expectedRevision"]);
  const source = {
    sourceId: input.segments[2]!,
    expectedRevision: readExpectedBasketRevision(body.expectedRevision),
  };
  if (action === "reindex") return service.refreshSource(source);
  return service.removeSource(source);
}

function requireBasketBody(body: JsonObject | null, fields: readonly string[]): JsonObject {
  if (!body) throw new InformationBasketError("basket_input_invalid");
  const allowed = new Set([...fields, "environment", "environmentId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new InformationBasketError("basket_input_invalid");
  return body;
}

function hasSourcePaths(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > BASKET_LIMITS.maxSources) return false;
  return value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4096);
}

function hasBasketRelinkPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value || value.length > 4096) return false;
  return !value.includes("\0");
}

function readExpectedBasketRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new InformationBasketError("basket_revision_invalid");
  return value;
}

function sendBasketManagementError(response: ServerResponse, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  // RPC preserves stable codes, never OS paths or parser diagnostics.
  if (typeof code === "string" && /^basket_[a-z_]+$/.test(code)) {
    const status = basketErrorStatus(code);
    sendJson(response, status, { ok: false, error: code });
    return;
  }
  const unavailable = error instanceof Error && error.message === "local_runtime_service_unavailable";
  sendJson(response, unavailable ? 503 : 500, {
    ok: false,
    error: unavailable ? "basket_service_unavailable" : "basket_management_failed",
  });
}

function basketErrorStatus(code: string): number {
  if (code.includes("not_found")) return 404;
  if (code.includes("unreadable")) return 403;
  if (code.includes("conflict") || code.includes("stale") || code.includes("changed_during")) return 409;
  if (["basket_disabled", "basket_source_not_ready", "basket_storage_host_mismatch"].includes(code)) return 409;
  if (code.includes("unavailable")) return 503;
  if (code.includes("storage")) return 503;
  return 400;
}
