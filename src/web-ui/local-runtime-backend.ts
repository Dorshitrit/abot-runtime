import { createOrdinaryChatEventPublisher } from "./local-runtime/agent-event-scope.js";
import { assertOrdinaryWebSession } from "../runtime/agents/session-association.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type WebSocket from "ws";

import { resolveProviderAdapters } from "../model-gateway/server/index.js";
import { LocalRuntimeApiRouter } from "./local-runtime/api-router.js";
import { LocalRuntimeControlRoutes } from "./local-runtime/control-routes.js";
import type { LocalRuntimeBackendOptions } from "./local-runtime/contracts.js";
import { RuntimeEnvironmentRegistry } from "./local-runtime/environment-registry.js";
import { sendJson } from "./local-runtime/http.js";
import { RequestBodyInputError } from "./local-runtime/request-body-error.js";
import { RuntimeSetupError } from "./local-runtime/runtime-setup-input.js";
import { requireRuntimeSetupEditSettled } from "./local-runtime/runtime-setup-edit-recovery.js";
import { LocalRealtimeController } from "./local-runtime/realtime-controller.js";
import { RealtimeClientHub } from "./local-runtime/realtime-hub.js";
import { LocalRequestExecution } from "./local-runtime/request-execution.js";
import { createWorkspaceChangeNotifier } from "./local-runtime/workspace-notifications.js";
import { createLearningChangeNotifier } from "./local-runtime/learning-notifications.js";
import { WebNotificationService } from "./notifications/service.js";
import { WebSessionReadStates } from "./session-read-state/service.js";
import { WebNotificationRoutes } from "./notifications/routes.js";
import { DesktopNotificationDelivery } from "./notifications/desktop-delivery.js";
import { validateRuntimeQueueTarget } from "./client-state/queue-target.js";
import { createSavedAppearanceReferenceReader } from "./client-state/appearance-reference.js";
import { createSparkHomeChangeNotifier } from "./local-runtime/spark-home-notifications.js";

export type { LocalRuntimeBackendOptions } from "./local-runtime/contracts.js";

/** Stable server-facing facade for the direct Runtime Web UI backend. */
export class LocalRuntimeWebBackend {
  private readonly clients: RealtimeClientHub;
  private readonly environments: RuntimeEnvironmentRegistry;
  private readonly api: LocalRuntimeApiRouter;
  private readonly realtime: LocalRealtimeController;
  private readonly controls: LocalRuntimeControlRoutes;
  private readonly notifications: WebNotificationService;
  private readonly ordinaryEvents: ReturnType<typeof createOrdinaryChatEventPublisher>;
  private readonly notificationRoutes: WebNotificationRoutes;

  constructor(options: LocalRuntimeBackendOptions) {
    requireRuntimeSetupEditSettled(options.rootDir ?? process.cwd());
    const resolvedOptions = {
      ...options,
      providerAdapters: resolveProviderAdapters({
        providerAdapters: options.providerAdapters,
      }),
    };
    const clients = new RealtimeClientHub((event) =>
      this.notifications.observe(event),
    );
    this.clients = clients;
    const requests = new LocalRequestExecution(clients);
    this.ordinaryEvents = createOrdinaryChatEventPublisher({
      runtimeDir: (id) => this.environments.get(id).services.config.paths.runtimeDir,
      publish: (event) => requests.publishScheduled(event),
      unavailable: (id) => console.error(`Chat event association unavailable for ${id}.`),
    });
    this.environments = new RuntimeEnvironmentRegistry(resolvedOptions, {
      homeAppearance: createSavedAppearanceReferenceReader(options.rootDir ?? process.cwd()),
      requestOptions: (run) => requests.scheduledRequestOptions(run),
      publish: this.ordinaryEvents.publish,
      publishLearning: createLearningChangeNotifier(clients),
      publishSparkHome: createSparkHomeChangeNotifier(clients),
      publishInformationBasket: (environmentId) =>
        createWorkspaceChangeNotifier(clients)(environmentId, ["information-basket"]),
    });
    const desktop = new DesktopNotificationDelivery(
      options.rootDir ?? process.cwd(),
    );
    const readStates = new WebSessionReadStates((id) => this.environments.get(id));
    this.notifications = new WebNotificationService({
      hasEnvironment: (id) => {
        const configured = this.environments.environmentConfig();
        if (!configured) return id === options.defaultEnvironmentId;
        return configured.environments.some(
          (environment) => environment.id === id,
        );
      },
      environment: (id) => this.environments.get(id),
      isViewing: (environment, session) =>
        clients.presence.isViewing(environment, session),
      isViewingAgent: (environment, id) => clients.presence.isViewingAgent(environment, id),
      changed: (environment) =>
        clients.broadcast({
          type: "workspace_changed",
          environment,
          resources: ["notifications"],
        }),
      readEvidence: (environment, session) => readStates.assistantReadEvidence(environment, session),
      desktop: () => desktop.status(),
      deliver: (item, signal) => desktop.send(item, signal),
    });
    this.notificationRoutes = new WebNotificationRoutes(this.notifications);
    this.api = new LocalRuntimeApiRouter(
      resolvedOptions,
      this.environments,
      requests,
      createWorkspaceChangeNotifier(clients),
      readStates,
      this.notifications.observeRead,
      this.notifications.observeApprovalDecision,
      this.notifications,
    );
    this.realtime = new LocalRealtimeController(
      resolvedOptions,
      this.environments,
      requests,
      clients,
      this.notifications.observeApprovalDecision,
    );
    this.controls = new LocalRuntimeControlRoutes(requests);
  }

  async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    try {
      if (await this.notificationRoutes.handle(req, res, pathname)) return true;
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
      const requiresSetupRecovery =
        error instanceof RuntimeSetupError &&
        error.code === "setup_edit_recovery_required";
      if (error instanceof RequestBodyInputError || requiresSetupRecovery) {
        sendJson(res, error.statusCode, {
          ok: false,
          error: error.code,
          message: error.message,
        });
        return true;
      }
      sendJson(res, 500, {
        ok: false,
        error: "local_runtime_backend_error",
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  validateQueueTarget(input: Record<string, unknown>): Promise<void> {
    return validateRuntimeQueueTarget(input, (id) => this.environments.get(id).services.sessions,
      (id, sessionId) => assertOrdinaryWebSession(this.environments.get(id).services.config.paths.runtimeDir, sessionId));
  }

  handleRealtimeConnection(client: WebSocket): void {
    this.realtime.connect(client);
  }

  notifyHostConnectionChanged(): void {
    this.clients.broadcast({ type: "system-host.changed" });
  }

  async start(environmentIds: readonly string[]): Promise<void> {
    await this.api.initializeSessionReadState(environmentIds);
    await this.environments.start(environmentIds);
    await this.api.startAgents(environmentIds);
  }

  environmentConfig() {
    return this.environments.environmentConfig();
  }

  nativePermissions(environmentId: string) {
    return this.environments.existingNativePermissions(environmentId);
  }

  async stop(): Promise<void> {
    // Fence new managed actions synchronously, before any existing cleanup awaits.
    const managedCleanup = (async () => { await this.api.closeManagedLlama(); })();
    const results = await Promise.allSettled([
      (async () => {
        await this.api.stopAgents();
        // Finish classifying accepted events while the environment and its notification store are available.
        await this.ordinaryEvents.stop();
        await this.notifications.stop();
        await this.environments.stop();
      })(),
      managedCleanup,
    ]);
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Runtime and managed llama.cpp cleanup failed.");
  }
}
