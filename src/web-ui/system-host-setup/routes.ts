import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostPairingStore } from "../../../plugins/system/source/companion/pairing-store.js";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "../local-runtime/http.js";
import { hostBearerCredential } from "./native-authorization.js";
import type { HostReadiness, HostSetupPlatform } from "./readiness.js";
import { renderCompanionInstaller, renderWslInteropInstaller } from "./installers.js";
import { InstallerInputError } from "./installer-contract.js";
import { readInstallerCompanionBundle } from "./companion-bundle.js";

const setupPath = "/web-api/runtime/system-host/setup";
const bundlePath = "/web-api/runtime/system-host/bundle";

export function isHostSetupRoute(pathname: string): boolean {
  return [setupPath, bundlePath].includes(pathname);
}

export function sendHostSetupInputError(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof InstallerInputError)) return false;
  sendJson(response, 400, { ok: false, error: "host_setup_input_rejected", message: error.message });
  return true;
}

function isSetupPlatformRequest(value: unknown): value is { platform: HostSetupPlatform } {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (Object.keys(value).length !== 1) return false;
  const platform = (value as Record<string, unknown>).platform;
  return platform === "windows" || platform === "macos";
}

function requestRuntimeOrigin(request: IncomingMessage): string {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  return new URL(`${encrypted ? "https" : "http"}://${request.headers.host}`).origin;
}

export type HostSetupRouteDependencies = {
  store: HostPairingStore;
  readiness(): Promise<HostReadiness>;
  prepareCompanion(): Promise<void>;
  bundleFile?: string;
};

/** GUI writes use same-origin JSON; native code downloads use the expiring setup grant. */
export class HostSetupRoutes {
  constructor(private readonly dependencies: HostSetupRouteDependencies) {}

  private async bundle(): Promise<Buffer> {
    if (this.dependencies.bundleFile) return readFile(this.dependencies.bundleFile);
    return readInstallerCompanionBundle();
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (pathname === bundlePath) {
      await this.downloadBundle(request, response);
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!acceptConfigMutationRequest(request, response)) return;
    const raw = await readBody(request, { maxBytes: 1024 });
    let input: unknown;
    try { input = JSON.parse(raw.toString()); } catch { /* rejected below */ }
    if (!isSetupPlatformRequest(input)) {
      sendJson(response, 400, { ok: false, error: "invalid_host_setup_platform" });
      return;
    }
    const readiness = await this.dependencies.readiness();
    if (!readiness.platforms.includes(input.platform)) {
      sendJson(response, 409, {
        ok: false,
        error: "host_setup_not_required",
        message: readiness.message ?? "Refresh the computer connection status.",
      });
      return;
    }
    if (readiness.environment === "wsl") {
      const installer = await renderWslInteropInstaller({ distribution: readiness.distribution });
      sendJson(response, 200, { ok: true, ...installer, restartRequired: true });
      return;
    }
    // Read and hash the exact running build before creating a setup grant.
    const bundle = await this.bundle();
    await this.dependencies.prepareCompanion();
    const pairing = this.dependencies.store.begin(15 * 60_000);
    const installer = await renderCompanionInstaller({
      platform: input.platform,
      url: requestRuntimeOrigin(request),
      code: pairing.code,
      expiresAt: pairing.expiresAt,
      bundleSha256: createHash("sha256").update(bundle).digest("hex"),
    });
    sendJson(response, 200, {
      ok: true,
      ...installer,
      expiresAt: pairing.expiresAt,
      restartRequired: false,
    });
  }

  private async downloadBundle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    const credential = hostBearerCredential(request);
    if (!this.hasCurrentSetupGrant(credential)) {
      sendJson(response, 401, { ok: false, error: "host_setup_expired" });
      return;
    }
    const bundle = await this.bundle();
    response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "content-length": bundle.byteLength,
      "x-content-type-options": "nosniff",
    });
    response.end(bundle);
  }

  private hasCurrentSetupGrant(credential: string | undefined): boolean {
    if (!credential) return false;
    return this.dependencies.store.authenticate(credential) === "pairing";
  }
}
