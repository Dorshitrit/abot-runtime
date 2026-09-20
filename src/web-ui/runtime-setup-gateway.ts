import {
  isLoopbackGateway,
  hasGatewayListener,
} from "./runtime-setup-gateway-address.js";
import type { Server } from "node:http";
import {
  createModelGatewayServer,
  type ModelGatewayHandlerOptions,
} from "../model-gateway/server.js";
import { loadRuntimeConfig } from "../runtime/config.js";
import { closeHttpServerImmediately } from "../shared/http-server-shutdown.js";
import type { RuntimeSetupActivation } from "./local-runtime/runtime-setup-input.js";

export type RuntimeSetupGatewayRestorePoint = {
  restore(): Promise<void>;
};

type OwnedGateway = { server: Server; host: string; port: number };
type GatewayCheckpoint = {
  owned: OwnedGateway | undefined;
  restoration?: Promise<void>;
};

function listenGateway(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Owns only a gateway started by this Web/CLI process, never an external service. */
export class RuntimeSetupGateway {
  private owned: OwnedGateway | undefined;
  private checkpoint: GatewayCheckpoint | undefined;
  private transition: Promise<unknown> | undefined;
  private closed = false;

  constructor(
    private readonly options: ModelGatewayHandlerOptions & { rootDir: string },
  ) {}

  private requireGatewayOpen(): void {
    if (this.closed) throw new Error("setup_gateway_closed");
  }

  private configuredBinding(configPath?: string) {
    const config = loadRuntimeConfig({
      rootDir: this.options.rootDir,
      configPath,
    });
    const url = new URL(config.modelGatewayUrl);
    const host = url.hostname === "[::1]" ? "::1" : url.hostname;
    const port = Number(url.port || "80");
    return { url, host, port };
  }

  async checkActivation(configPath?: string): Promise<RuntimeSetupActivation> {
    this.requireGatewayOpen();
    const { url, host, port } = this.configuredBinding(configPath);
    if (!isLoopbackGateway(url)) {
      return {
        status: "restart_required",
        message:
          "Configuration saved. The configured model gateway is managed outside this Web UI.",
      };
    }
    const ownAddress = this.owned?.server.address();
    const ownsTargetPort =
      ownAddress && typeof ownAddress !== "string" && ownAddress.port === port;
    const ownedHost = ownsTargetPort ? ownAddress.address : undefined;
    const externalListener = await hasGatewayListener(port, host, ownedHost);
    this.requireGatewayOpen();
    if (externalListener) {
      return {
        status: "restart_required",
        message:
          "Configuration saved. An existing model gateway owns this address; restart that gateway to load its new configuration.",
      };
    }
    return { status: "ready" };
  }

  private captureGatewayCheckpoint(): GatewayCheckpoint {
    this.requireGatewayOpen();
    return (this.checkpoint ??= { owned: this.owned });
  }

  /** Retains the old server's compiled handlers, without rereading saved config. */
  createRestorePoint(): RuntimeSetupGatewayRestorePoint {
    const checkpoint = this.captureGatewayCheckpoint();
    return { restore: () => this.restoreGatewayCheckpoint(checkpoint) };
  }

  private restoreGatewayCheckpoint(
    checkpoint: GatewayCheckpoint,
    activationOwnsTransition = false,
  ): Promise<void> {
    if (checkpoint.restoration) return checkpoint.restoration;
    if (this.checkpoint === checkpoint) this.checkpoint = undefined;
    const restore = () => this.replaceOwnedGateway(checkpoint.owned);
    checkpoint.restoration = activationOwnsTransition
      ? restore()
      : this.runGatewayTransition(restore);
    return checkpoint.restoration;
  }

  private async runGatewayTransition<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.requireGatewayOpen();
    if (this.transition)
      throw new Error("setup_gateway_transition_in_progress");
    const pending = Promise.resolve().then(operation);
    this.transition = pending;
    try {
      return await pending;
    } finally {
      if (this.transition === pending) this.transition = undefined;
    }
  }

  private async replaceOwnedGateway(
    target: OwnedGateway | undefined,
  ): Promise<void> {
    this.requireGatewayOpen();
    const isTargetAlreadyActive =
      target === this.owned && target?.server.listening === true;
    if (isTargetAlreadyActive) return;
    const current = this.owned;
    if (current?.server.listening) {
      await closeHttpServerImmediately(current.server);
      this.requireGatewayOpen();
    }
    this.owned = undefined;
    if (!target) return;
    this.requireGatewayOpen();
    this.owned = target;
    try {
      await listenGateway(target.server, target.port, target.host);
      this.requireGatewayOpen();
      const address = target.server.address();
      if (address && typeof address !== "string") {
        target.host = address.address;
        target.port = address.port;
      }
    } catch (error) {
      return this.failAfterGatewayCleanup(target, error);
    }
  }

  private closeGatewayListener(owned: OwnedGateway): Promise<void> {
    if (!owned.server.listening) return Promise.resolve();
    return closeHttpServerImmediately(owned.server);
  }

  private async failAfterGatewayCleanup(
    target: OwnedGateway,
    error: unknown,
  ): Promise<never> {
    try {
      await this.closeGatewayListener(target);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Model gateway activation failed and its listener could not be closed.",
      );
    }
    if (this.owned === target) this.owned = undefined;
    throw error;
  }

  activate(configPath?: string): Promise<RuntimeSetupActivation> {
    return this.runGatewayTransition(async () => {
      const checkpoint = this.captureGatewayCheckpoint();
      this.checkpoint = undefined;
      try {
        const allowed = await this.checkActivation(configPath);
        this.requireGatewayOpen();
        if (allowed.status !== "ready") return allowed;
        const { host, port } = this.configuredBinding(configPath);
        const server = createModelGatewayServer({
          ...this.options,
          configPath,
        });
        await this.replaceOwnedGateway({ server, host, port });
        this.requireGatewayOpen();
        return { status: "ready" };
      } catch (error) {
        if (this.closed) throw error;
        try {
          await this.restoreGatewayCheckpoint(checkpoint, true);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Model gateway activation failed and the previous gateway could not be restored.",
          );
        }
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.transition?.catch(() => {});
    const owned = this.owned;
    this.owned = undefined;
    if (owned?.server.listening) await closeHttpServerImmediately(owned.server);
  }
}
