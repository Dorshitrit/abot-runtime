import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { installLocalMacCompanion, LocalCompanionSetupError } from "../../computer-access/companion/local-installation.js";
import { acceptConfigMutationRequest } from "../local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "../local-runtime/http.js";
import { canSetUpLocalMac, localMacSetupRuntimeUrl } from "./local-setup-availability.js";
import type { HostReadiness } from "./readiness.js";

export const LOCAL_HOST_SETUP_PATH = "/web-api/runtime/system-host/connect-local";

function isEmptyLocalSetupRequest(body: unknown): boolean {
  return JSON.stringify(body) === "{}";
}

export class LocalHostConnection {
  private pending?: Promise<void>;

  constructor(private readonly dependencies: {
    store: HostPairingStore;
    readiness(): Promise<HostReadiness>;
    prepareCompanion(): Promise<void>;
    bundle(): Promise<Buffer>;
    install?: typeof installLocalMacCompanion;
  }) {}

  get busy(): boolean { return this.pending !== undefined; }

  rejectConcurrentMutation(response: ServerResponse): boolean {
    if (!this.busy) return false;
    sendJson(response, 409, { ok: false, error: "host_setup_in_progress",
      message: "Computer access is being connected. Wait for setup to finish." });
    return true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!acceptConfigMutationRequest(request, response)) return;
    const raw = await readBody(request, { maxBytes: 1024 });
    let body: unknown;
    try { body = JSON.parse(raw.toString()); } catch { /* rejected below */ }
    if (!isEmptyLocalSetupRequest(body)) {
      sendJson(response, 400, { ok: false, error: "unexpected_host_configuration_fields" });
      return;
    }
    const readiness = await this.dependencies.readiness();
    if (!canSetUpLocalMac(request, readiness)) {
      sendJson(response, 409, { ok: false, error: "host_local_setup_unavailable",
        message: "Direct setup requires ABot running natively on this Mac through its local address. Use a pairing code on the Mac for Docker or a forwarded Runtime." });
      return;
    }
    if (this.rejectConcurrentMutation(response)) return;
    const pending = this.connect(localMacSetupRuntimeUrl(request));
    this.pending = pending;
    try {
      await pending;
      sendJson(response, 200, { ok: true });
    } catch (error) {
      if (!(error instanceof LocalCompanionSetupError)) throw error;
      sendJson(response, 503, { ok: false, error: error.code, message: error.message });
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  private async connect(url: string): Promise<void> {
    const bundle = await this.dependencies.bundle();
    await this.dependencies.prepareCompanion();
    const host = this.dependencies.store.host();
    const grant = host
      ? this.dependencies.store.beginBundleUpgrade()
      : this.dependencies.store.begin(15 * 60_000);
    await (this.dependencies.install ?? installLocalMacCompanion)({
      bundle, url, code: grant.code,
      ...(host ? { upgradeHostId: host.hostId } : {}),
    });
  }

  async close(): Promise<void> { await this.pending?.catch(() => undefined); }
}
