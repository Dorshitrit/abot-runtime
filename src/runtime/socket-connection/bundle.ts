import { validateRuntimeBridgeConnection, type RuntimeBridgeConnection } from "../../bridge/runtime-connection.js";
import { normalizeRuntimeId } from "../../shared/agent.js";
import type { SocketConnectionPreview } from "./contracts.js";

function invalid(): never { throw new Error("socket_connection_bundle_invalid"); }

export function parseSocketConnectionBundle(bundle: unknown): RuntimeBridgeConnection {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return invalid();
  const row = bundle as Record<string, unknown>;
  const legacy = Object.hasOwn(row, "endpoint") || Object.hasOwn(row, "token");
  const allowed = legacy ? ["runtimeId", "endpoint", "token"] : ["runtimeId", "agentBridgeUrl", "runtimeToken"];
  if (Object.keys(row).length !== 3 || Object.keys(row).some(key => !allowed.includes(key)) ||
      typeof row.runtimeId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(row.runtimeId)) return invalid();
  try {
    const connection = validateRuntimeBridgeConnection({
      runtimeId: row.runtimeId,
      url: legacy ? row.endpoint : row.agentBridgeUrl,
      token: legacy ? row.token : row.runtimeToken,
    }, row.runtimeId);
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(connection.token)) return invalid();
    const url = new URL(connection.url);
    if (url.search || (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return invalid();
    return connection;
  } catch { return invalid(); }
}

export function socketRegistrationId(connection: RuntimeBridgeConnection, exact: boolean): string {
  return exact ? connection.runtimeId : normalizeRuntimeId(connection.runtimeId);
}

export function socketConnectionPreview(localEnvironmentId: string, connection: RuntimeBridgeConnection): SocketConnectionPreview {
  return { localEnvironmentId, remoteRuntimeId: connection.runtimeId, serverOrigin: new URL(connection.url).origin,
    bindingConfirmationRequired: localEnvironmentId !== connection.runtimeId };
}
