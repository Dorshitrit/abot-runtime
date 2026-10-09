import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";
import { createStoreConnectionLink, normalizeStoreConnectionOrigin } from "../../computer-access/companion/windows-store/connection-link.js";
import { WINDOWS_COMPANION_STORE_URL } from "../../computer-access/companion/windows-store/identity.js";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "../local-runtime/http.js";
import type { HostReadiness } from "./readiness.js";
import type { HostSetupMutation } from "./setup-mutation.js";

export const WINDOWS_STORE_CONNECTION_PATH = "/web-api/runtime/system-host/store-connect";

type StoreConnectionDependencies = Readonly<{
  store: HostPairingStore;
  readiness(): Promise<HostReadiness>;
  prepareCompanion(): Promise<void>;
  mutation: HostSetupMutation;
}>;

function canStartWindowsStoreConnection(readiness: HostReadiness): boolean {
  if (!readiness.platforms.includes("windows")) return false;
  if (readiness.restartRequired) return false;
  if (readiness.route === "wsl_interop") return false;
  return readiness.route !== "native";
}

function hasEmptyConnectionBody(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === 0;
}

export async function handleWindowsStoreConnection(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: StoreConnectionDependencies,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  if (!acceptConfigMutationRequest(request, response)) return;
  let body: unknown;
  try { body = JSON.parse((await readBody(request, { maxBytes: 1_024 })).toString()); }
  catch { /* rejected below */ }
  if (!hasEmptyConnectionBody(body)) {
    sendJson(response, 400, { ok: false, error: "invalid_store_connection_request" });
    return;
  }
  await dependencies.mutation.run(response, () => issueWindowsStoreConnection(request, response, dependencies));
}

async function issueWindowsStoreConnection(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: StoreConnectionDependencies,
): Promise<void> {
  if (!canStartWindowsStoreConnection(await dependencies.readiness())) {
    sendJson(response, 409, { ok: false, error: "host_setup_not_required", message: "Refresh the computer connection status." });
    return;
  }
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  let origin: string;
  try {
    origin = normalizeStoreConnectionOrigin(`${encrypted ? "https" : "http"}://${request.headers.host}`);
  } catch {
    sendJson(response, 400, { ok: false, error: "host_store_connection_rejected", message: "Store connection requires a local HTTP Runtime origin on this computer." });
    return;
  }
  await dependencies.prepareCompanion();
  const previous = dependencies.store.host();
  const pairing = previous ? dependencies.store.beginBundleUpgrade() : dependencies.store.begin(15 * 60_000);
  try {
    const launchUrl = createStoreConnectionLink({
      version: 1, url: origin, code: pairing.code, expiresAt: pairing.expiresAt,
      companionRelease: COMPANION_RELEASE_VERSION,
      ...(previous ? { upgradeHostId: previous.hostId } : {}),
    });
    sendJson(response, 200, { ok: true, launchUrl, expiresAt: pairing.expiresAt, storeUrl: WINDOWS_COMPANION_STORE_URL });
  } catch {
    sendJson(response, 400, { ok: false, error: "host_store_connection_rejected", message: "Store connection requires a local HTTP Runtime origin on this computer." });
  }
}
