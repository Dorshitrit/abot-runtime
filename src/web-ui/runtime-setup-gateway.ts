import {
  isLoopbackGateway,
  hasGatewayListener,
} from "./runtime-setup-gateway-address.js";
import type { Server } from "node:http";
import {
  createModelGatewayServer,
  type ModelGatewayHandlerOptions,
} from "../model-gateway/server.js";
import { captureModelGatewayConfiguration } from "../model-gateway/server/configuration.js";
import { loadRuntimeConfig } from "../runtime/config.js";
import { closeHttpServerImmediately } from "../shared/http-server-shutdown.js";
import type { RuntimeSetupActivation } from "./local-runtime/runtime-setup-input.js";

export type RuntimeSetupGatewayRestorePoint = {
  restore(): Promise<void>;
};

export type AppliedGatewayConfigurations = readonly (string | null)[];

type GatewayActivationPlan =
  | { status: "ready"; retainExternal: boolean }
  | (RuntimeSetupActivation & { status: "restart_required" });

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

  captureConfiguration(configPath?: string): string | null {
    return captureModelGatewayConfiguration({ ...this.options, configPath });
  }

  private matchesAppliedConfiguration(
    configPath: string | undefined,
    applied: AppliedGatewayConfigurations | undefined,
  ): boolean {
    if (this.owned) return false;
    if (!applied?.length) return false;
    const candidate = this.captureConfiguration(configPath);
    return (
      candidate !== null && applied.every((previous) => previous === candidate)
    );
  }

  async checkActivation(
    configPath?: string,
    applied?: AppliedGatewayConfigurations,
  ): Promise<RuntimeSetupActivation> {
    const plan = await this.planActivation(configPath, applied);
    return plan.status === "ready" ? { status: "ready" } : plan;
  }

  private async planActivation(
    configPath?: string,
    applied?: AppliedGatewayConfigurations,
  ): Promise<GatewayActivationPlan> {
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
    if (!externalListener) return { status: "ready", retainExternal: false };
    if (this.matchesAppliedConfiguration(configPath, applied))
      return { status: "ready", retainExternal: true };
    return {
      status: "restart_required",
      message:
        `Configuration saved. Another process is listening at ${url.origin}. It may belong to a different ABot installation. For this installation, set modelGatewayUrl in local/runtime.config.json to an unused loopback address, such as http://127.0.0.1:3001, then try again. If MODEL_GATEWAY_URL is set, update it and restart this ABot instance.`,
    };
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

  activate(
    configPath?: string,
    applied?: AppliedGatewayConfigurations,
  ): Promise<RuntimeSetupActivation> {
    return this.runGatewayTransition(async () => {
      const checkpoint = this.captureGatewayCheckpoint();
      this.checkpoint = undefined;
      try {
        const allowed = await this.planActivation(configPath, applied);
        this.requireGatewayOpen();
        if (allowed.status !== "ready") return allowed;
        // Unchanged requirements do not grant ownership of the external listener.
        if (allowed.retainExternal) return { status: "ready" };
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
