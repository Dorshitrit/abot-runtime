import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { HostConnection } from "../../plugins/system/source/companion/connection.js";
import { HostPairingStore } from "../../plugins/system/source/companion/pairing-store.js";
import { startHostBroker } from "../../plugins/system/source/companion/broker-server.js";
import { hostStateDirectory } from "../../plugins/system/source/companion/private-store.js";
import {
  HOST_SOCKET_PATH,
  HOST_WIRE_MAX_BYTES,
} from "../../plugins/system/source/companion/protocol.js";
import {
  isProcessOwnerAlive,
  requireCurrentProcessOwnerIdentity,
} from "../../plugins/system/source/companion/process-owner-identity.js";
import { ensurePrivateRuntimeDirectory } from "../runtime/local-host/private-directory.js";
import { acquireFileLock } from "../runtime/adapters/long-term-memory/file-lock/acquisition.js";
import { acceptConfigMutationRequest } from "./local-runtime/config-mutation-request.js";
import { readBody, sendJson } from "./local-runtime/http.js";
import { hostBearerCredential } from "./system-host-setup/native-authorization.js";
import { hasTrustedSystemHostUpgrade, rejectSystemHostUpgrade } from "./system-host-upgrade-authority.js";
import { readHostReadiness } from "./system-host-setup/readiness.js";
import { HostSetupRoutes, isHostSetupRoute, sendHostSetupInputError } from "./system-host-setup/routes.js";
function isSystemHostRoute(pathname: string): boolean {
  if (pathname === "/web-api/runtime/system-host") return true;
  return pathname === "/web-api/runtime/system-host/pairing";
}
export class WebSystemHostService {
  private readonly store: HostPairingStore;
  private readonly connection: HostConnection;
  private readonly setup: HostSetupRoutes;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: HOST_WIRE_MAX_BYTES,
    perMessageDeflate: false,
  });
  private broker?: Awaited<ReturnType<typeof startHostBroker>>;
  private starting?: Promise<void>;
  private closing = false;
  constructor(private readonly rootDir: string) {
    this.store = new HostPairingStore(rootDir);
    this.connection = new HostConnection(this.store);
    this.setup = new HostSetupRoutes({
      store: this.store,
      readiness: () => readHostReadiness(this.connection.status()),
      prepareCompanion: () => this.ensureStarted(),
    });
  }
  private ensureStarted(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("host_service_stopped"));
    this.starting ??= (async () => {
      await ensurePrivateRuntimeDirectory(hostStateDirectory(this.rootDir));
      const ownerIdentity = await requireCurrentProcessOwnerIdentity();
      this.broker = await startHostBroker(this.rootDir, this.connection, () =>
        acquireFileLock(join(hostStateDirectory(this.rootDir), "owner.lock"), {
          waitMs: 0,
          ownerIdentity,
          processIsAlive: isProcessOwnerAlive,
        }),
      );
    })().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }
  /** Native upgrade is separate from browser realtime and requires its own credential. */
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    listenHost = "127.0.0.1",
  ): boolean {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== HOST_SOCKET_PATH) return false;
    if (!hasTrustedSystemHostUpgrade(request, listenHost)) {
      rejectSystemHostUpgrade(socket);
      return true;
    }
    void this.acceptCompanion(request, socket, head).catch(() =>
      socket.destroy(),
    );
    return true;
  }
  private async acceptCompanion(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    await this.ensureStarted();
    const token = hostBearerCredential(request);
    if (!token || !this.store.authenticate(token)) {
      rejectSystemHostUpgrade(socket);
      return;
    }
    if (this.wss.clients.size >= 4) {
      socket.destroy();
      return;
    }
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (client) =>
      this.connection.accept(client, token),
    );
  }
  async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!isSystemHostRoute(pathname) && !isHostSetupRoute(pathname)) return false;
    response.setHeader("cache-control", "no-store");
    try {
      if (isHostSetupRoute(pathname)) {
        await this.setup.handle(request, response, pathname);
        return true;
      }
      if (
        request.method === "GET" &&
        pathname === "/web-api/runtime/system-host"
      ) {
        const status = this.connection.status();
        const readiness = await readHostReadiness(status);
        sendJson(response, 200, { ok: true, ...status, readiness });
        return true;
      }
      if (!acceptConfigMutationRequest(request, response)) return true;
      const raw = await readBody(request, { maxBytes: 1024 });
      const body = raw.length ? (JSON.parse(raw.toString()) as unknown) : {};
      if (JSON.stringify(body) !== "{}") {
        sendJson(response, 400, {
          ok: false,
          error: "unexpected_host_configuration_fields",
        });
        return true;
      }
      if (request.method === "POST" && pathname.endsWith("/pairing")) {
        await this.ensureStarted();
        sendJson(response, 200, { ok: true, ...this.store.begin() });
        return true;
      }
      if (
        request.method === "DELETE" &&
        pathname === "/web-api/runtime/system-host"
      ) {
        await this.ensureStarted();
        this.store.revoke();
        this.connection.disconnect();
        const status = this.connection.status();
        sendJson(response, 200, { ok: true, ...status, readiness: await readHostReadiness(status) });
        return true;
      }
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    } catch (error) {
      if (sendHostSetupInputError(response, error)) return true;
      const alreadyPaired =
        error instanceof Error && error.message === "host_already_paired";
      sendJson(response, alreadyPaired ? 409 : 503, {
        ok: false,
        error: alreadyPaired
          ? "host_already_paired"
          : "host_connection_unavailable",
        message: alreadyPaired
          ? "Disconnect the paired computer before creating a new pairing."
          : "The host connection service could not be started or updated.",
      });
    }
    return true;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.starting?.catch(() => undefined);
    this.connection.close();
    await this.broker?.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
