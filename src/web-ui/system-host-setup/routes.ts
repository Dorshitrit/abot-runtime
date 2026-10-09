import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "../local-runtime/http.js";
import { hostBearerCredential } from "./native-authorization.js";
import type { HostReadiness, HostSetupPlatform } from "./readiness.js";
import {
  renderCompanionInstaller,
} from "./installers.js";
import { InstallerInputError, type CompanionInstallerInput } from "./installer-contract.js";
import { WINDOWS_COMPANION_STORE_URL } from "../../computer-access/companion/windows-store/identity.js";
import { readInstallerCompanionBundle } from "./companion-bundle.js";
import { LocalHostConnection, LOCAL_HOST_SETUP_PATH } from "./local-connection.js";
import { handleWindowsStoreConnection, WINDOWS_STORE_CONNECTION_PATH } from "./windows-store-route.js";
import { HostSetupMutation } from "./setup-mutation.js";

const setupPath = "/web-api/runtime/system-host/setup";
const bundlePath = "/web-api/runtime/system-host/bundle";

export function isHostSetupRoute(pathname: string): boolean {
  return [setupPath, bundlePath, LOCAL_HOST_SETUP_PATH, WINDOWS_STORE_CONNECTION_PATH].includes(pathname);
}

export function sendHostSetupInputError(
  response: ServerResponse,
  error: unknown,
): boolean {
  if (!(error instanceof InstallerInputError)) return false;
  sendJson(response, 400, {
    ok: false,
    error: "host_setup_input_rejected",
    message: error.message,
  });
  return true;
}

function isSetupPlatformRequest(
  value: unknown,
): value is { platform: HostSetupPlatform; purpose?: "learning" } {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !["platform", "purpose"].includes(key)))
    return false;
  const input = value as Record<string, unknown>;
  if (input.purpose !== undefined && input.purpose !== "learning") return false;
  const platform = input.platform;
  if (platform === "linux") return true;
  return platform === "windows" || platform === "macos";
}

function canDownloadCompanionInstaller(
  platform: HostSetupPlatform,
): platform is CompanionInstallerInput["platform"] {
  return platform === "macos" || platform === "linux";
}

function requestRuntimeOrigin(request: IncomingMessage): string {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  return new URL(`${encrypted ? "https" : "http"}://${request.headers.host}`)
    .origin;
}

export type HostSetupRouteDependencies = {
  store: HostPairingStore;
  readiness(): Promise<HostReadiness>;
  prepareCompanion(): Promise<void>;
  bundleFile?: string;
};

/** GUI writes use same-origin JSON; native code downloads use the expiring setup grant. */
export class HostSetupRoutes {
  private readonly mutation = new HostSetupMutation();
  private readonly local: LocalHostConnection;
  constructor(private readonly dependencies: HostSetupRouteDependencies) {
    this.local = new LocalHostConnection({ ...dependencies, mutation: this.mutation, bundle: () => this.bundle() });
  }

  rejectConcurrentMutation(response: ServerResponse): boolean {
    return this.mutation.rejectConcurrentMutation(response);
  }

  async close(): Promise<void> { await this.mutation.close(); }

  private async bundle(): Promise<Buffer> {
    if (this.dependencies.bundleFile)
      return readFile(this.dependencies.bundleFile);
    return readInstallerCompanionBundle();
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (pathname === WINDOWS_STORE_CONNECTION_PATH) {
      await handleWindowsStoreConnection(request, response, {
        ...this.dependencies,
        mutation: this.mutation,
      });
      return;
    }
    if (pathname === LOCAL_HOST_SETUP_PATH) {
      await this.local.handle(request, response);
      return;
    }
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
    try {
      input = JSON.parse(raw.toString());
    } catch {
      /* rejected below */
    }
    if (!isSetupPlatformRequest(input)) {
      sendJson(response, 400, {
        ok: false,
        error: "invalid_host_setup_platform",
      });
      return;
    }
    const platform = input.platform;
    if (!canDownloadCompanionInstaller(platform)) {
      sendJson(response, 410, {
        ok: false,
        error: "windows_store_required",
        message: "Install or update ABot AI Companion through Microsoft Store.",
        storeUrl: WINDOWS_COMPANION_STORE_URL,
      });
      return;
    }
    await this.mutation.run(response, () => this.issueSetupInstaller(request, response, platform));
  }

  private async issueSetupInstaller(
    request: IncomingMessage,
    response: ServerResponse,
    platform: CompanionInstallerInput["platform"],
  ): Promise<void> {
    const readiness = await this.dependencies.readiness();
    if (!readiness.platforms.includes(platform)) {
      sendJson(response, 409, {
        ok: false,
        error: "host_setup_not_required",
        message: readiness.message ?? "Refresh the computer connection status.",
      });
      return;
    }
    // Read and hash the exact running build before creating a setup grant.
    const bundle = await this.bundle();
    await this.dependencies.prepareCompanion();
    const upgrading = Boolean(this.dependencies.store.host());
    const pairing = upgrading
      ? this.dependencies.store.beginBundleUpgrade()
      : this.dependencies.store.begin(15 * 60_000);
    const installer = await renderCompanionInstaller({
      platform,
      url: requestRuntimeOrigin(request),
      code: pairing.code,
      expiresAt: pairing.expiresAt,
      ...(upgrading
        ? { upgradeHostId: this.dependencies.store.host()!.hostId }
        : {}),
      bundleSha256: createHash("sha256").update(bundle).digest("hex"),
    });
    sendJson(response, 200, {
      ok: true,
      ...installer,
      expiresAt: pairing.expiresAt,
      restartRequired: false,
    });
  }

  private async downloadBundle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
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
    if (this.dependencies.store.authenticate(credential) === "pairing")
      return true;
    return this.dependencies.store.authenticateBundleUpgrade(credential);
  }
}
