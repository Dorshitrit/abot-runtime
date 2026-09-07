import type { IncomingMessage, ServerResponse } from "node:http";
import type WebSocket from "ws";

import { resolveProviderAdapters } from "../model-gateway/server/index.js";
import { LocalRuntimeApiRouter } from "./local-runtime/api-router.js";
import { LocalRuntimeControlRoutes } from "./local-runtime/control-routes.js";
import type { LocalRuntimeBackendOptions } from "./local-runtime/contracts.js";
import { RuntimeEnvironmentRegistry } from "./local-runtime/environment-registry.js";
import { sendJson } from "./local-runtime/http.js";
import { LocalRealtimeController } from "./local-runtime/realtime-controller.js";
import { RealtimeClientHub } from "./local-runtime/realtime-hub.js";
import { LocalRequestExecution } from "./local-runtime/request-execution.js";

export type { LocalRuntimeBackendOptions } from "./local-runtime/contracts.js";

/** Stable server-facing facade for the direct Runtime Web UI backend. */
export class LocalRuntimeWebBackend {
  private readonly environments: RuntimeEnvironmentRegistry;
  private readonly api: LocalRuntimeApiRouter;
  private readonly realtime: LocalRealtimeController;
  private readonly controls: LocalRuntimeControlRoutes;

  constructor(options: LocalRuntimeBackendOptions) {
    const resolvedOptions = {
      ...options,
      providerAdapters: resolveProviderAdapters({
        providerAdapters: options.providerAdapters,
      }),
    };
    const clients = new RealtimeClientHub();
    const requests = new LocalRequestExecution(clients);
    this.environments = new RuntimeEnvironmentRegistry(resolvedOptions, {
      requestOptions: (run) => requests.scheduledRequestOptions(run),
      publish: (event) => requests.publishScheduled(event),
    });
    this.api = new LocalRuntimeApiRouter(
      resolvedOptions,
      this.environments,
      requests,
    );
    this.realtime = new LocalRealtimeController(
      resolvedOptions,
      this.environments,
      requests,
      clients,
    );
    this.controls = new LocalRuntimeControlRoutes(requests);
  }

  async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    try {
      if (pathname === "/web-health" || pathname === "/web-api/health") {
        this.controls.health(res);
        return true;
      }
      if (
        pathname === "/web-agent-mode" ||
        pathname === "/web-api/agent-mode"
      ) {
        await this.controls.agentModeRoute(req, res);
        return true;
      }
      if (pathname === "/assistant-host/assistant/status") {
        this.controls.assistantStatus(res);
        return true;
      }
      if (
        pathname === "/assistant-host/assistant/tick" ||
        pathname === "/assistant-host/assistant/feedback"
      ) {
        this.controls.assistantMutationFallback(res);
        return true;
      }
      if (pathname.startsWith("/web-api/") || pathname === "/web-api") {
        await this.api.handle(req, res);
        return true;
      }
      return false;
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: "local_runtime_backend_error",
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  handleRealtimeConnection(client: WebSocket): void {
    this.realtime.connect(client);
  }

  async start(environmentIds: readonly string[]): Promise<void> {
    await this.api.initializeSessionReadState(environmentIds);
    await this.environments.start(environmentIds);
  }

  stop(): Promise<void> {
    return this.environments.stop();
  }
}
