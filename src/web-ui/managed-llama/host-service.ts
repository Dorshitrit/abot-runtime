import { ManagedLlamaService } from "./service.js";
import { ManagedLlamaRoutes } from "./routes.js";
import { ManagedLlamaServerManager } from "./server/manager.js";
import { ManagedLlamaServerRoutes } from "./server/routes.js";
import { serverFailure } from "./server/settings.js";
import type { ReadyLlamaConnection } from "./lifecycle.js";

/** Application composition: legacy single-model operations and server management
 * share one installation and cannot launch competing owned engines.
 */
export class ManagedLlamaHostService extends ManagedLlamaService {
  readonly server: ManagedLlamaServerManager;
  constructor(root: string) {
    super(root);
    this.server = new ManagedLlamaServerManager(root, {
      status: () => super.status(), capabilities: () => super.capabilities(),
      install: () => super.install(), refreshStatus: () => super.refreshStatus(), cancel: () => super.cancel(),
    });
  }
  override start(input: unknown) {
    if (this.server.isBusy()) return Promise.reject(serverFailure("busy"));
    return super.start(input);
  }
  override install() {
    if (this.server.isBusy()) return Promise.reject(serverFailure("busy"));
    return super.install();
  }
  override refreshStatus() {
    if (this.server.isBusy()) return Promise.reject(serverFailure("busy"));
    return super.refreshStatus();
  }
  override readyConnectionForConfiguration(alias?: string): (ReadyLlamaConnection & { revision?: string }) | null {
    if (this.server.status().configured) return this.server.connection(alias);
    return super.readyConnectionForConfiguration();
  }
  override async close(): Promise<void> {
    const results = await Promise.allSettled([this.server.close(), super.close()]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
export class ManagedLlamaHostRoutes extends ManagedLlamaRoutes {
  private readonly serverRoutes: ManagedLlamaServerRoutes;
  constructor(service: ManagedLlamaHostService) { super(service); this.serverRoutes = new ManagedLlamaServerRoutes(service.server); }
  override async handle(params: Parameters<ManagedLlamaRoutes["handle"]>[0]): Promise<boolean> {
    if (await this.serverRoutes.handle(params)) return true;
    return super.handle(params);
  }
}
