import { ProjectRoutes } from "./project-routes.js";
import { cancelWebRequest } from "./request-cancellation-route.js";
import { ConversationFileRoutes } from "./conversation-file-routes.js";
import { ConfigFileConflictError } from "../../runtime/adapters/config-file-transaction.js";
import { ModelSetupRoutes } from "./model-setup-routes.js";
import { ModelSetupService } from "./model-setup-service.js";
import { SetupEmbeddingRoutes } from "./setup-embedding-routes.js";
import { SetupEmbeddingService } from "./setup-embedding-service.js";
import { RuntimeSetupRoutes } from "./runtime-setup-routes.js";
import { RuntimeSetupService } from "./runtime-setup-service.js";
import {
  applyAndCompleteRuntimeSetup,
  pendingRuntimeSetupCatalog,
} from "./runtime-setup-completion.js";
import { PluginManagementRoutes } from "./plugin-management-routes.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { WebSessionRoutes } from "./session-routes.js";
import type { WorkspaceChangeNotifier } from "./workspace-notifications.js";
import { ToolApprovalRoutes } from "./tool-approval-routes.js";
import { ManagedWebToolApprovals } from "./managed-tool-approvals.js";
import { WebSessionReadStates } from "../session-read-state/service.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  getRuntimeConfig,
  getRuntimeConfigSchema,
} from "../../runtime/admin/config-control.js";
import {
  getRuntimeStatus,
  tailRuntimeLog,
} from "../../runtime/admin/system-control.js";
import {
  getConfigDashboardSnapshot,
  getSettledConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../config-dashboard-backend.js";
import { LocalAttachmentRoutes } from "./attachment-routes.js";
import { createLocalLongTermMemoryOnboardingService } from "../../runtime/adapters/long-term-memory/onboarding-service.js";
import type {
  ResolvedLocalRuntimeBackendOptions,
  RuntimeSetupRequirement,
} from "./contracts.js";
import { RuntimeEnvironmentRegistry } from "./environment-registry.js";
import {
  getString,
  pathSegments,
  readBody,
  readConfigFileKind,
  readJsonBody,
  requestEnvironmentId,
  sendJson,
} from "./http.js";
import { LocalRequestExecution } from "./request-execution.js";
import { LongTermMemoryManagementRoutes } from "./memory-management-routes.js";
import { LongTermMemoryOnboardingRoutes } from "./memory-onboarding-routes.js";
import { ScheduleManagementRoutes } from "./schedule-management-routes.js";
import { PassiveLearningRoutes } from "./learning-routes.js";

function sendRuntimeSetupRequired(
  res: ServerResponse,
  availability: RuntimeSetupRequirement,
): void {
  sendJson(res, 409, {
    ok: false,
    error: "runtime_setup_required",
    message: availability.message,
    availability,
  });
}

export class LocalRuntimeApiRouter {
  private readonly conversationFiles: ConversationFileRoutes;
  private readonly attachments = new LocalAttachmentRoutes();
  private readonly setup: RuntimeSetupRoutes;
  private readonly modelSetup: ModelSetupRoutes;
  private readonly setupEmbedding: SetupEmbeddingRoutes;
  private readonly plugins: PluginManagementRoutes;
  private readonly memoryManagement: LongTermMemoryManagementRoutes;
  private readonly memoryOnboarding: LongTermMemoryOnboardingRoutes;
  private readonly schedules: ScheduleManagementRoutes;
  private readonly readStates: WebSessionReadStates;
  private readonly sessions: WebSessionRoutes;
  private readonly projects = new ProjectRoutes();
  private readonly toolApprovals: ToolApprovalRoutes;
  private readonly learning: PassiveLearningRoutes;

  constructor(
    private readonly options: ResolvedLocalRuntimeBackendOptions,
    private readonly environments: RuntimeEnvironmentRegistry,
    private readonly requests: LocalRequestExecution,
    notifyWorkspaceChanged?: WorkspaceChangeNotifier,
  ) {
    this.toolApprovals = new ToolApprovalRoutes(
      new ManagedWebToolApprovals((id) => environments.get(id), requests),
    );
    this.learning = new PassiveLearningRoutes(
      (id) => this.environments.get(id).services.passiveLearning,
    );
    this.conversationFiles = new ConversationFileRoutes(
      environments,
      requests,
      () => this.options.defaultEnvironmentId,
    );
    this.modelSetup = new ModelSetupRoutes(
      new ModelSetupService({
        rootDir: options.rootDir ?? process.cwd(),
        getConfigPath: () =>
          options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
      }),
    );
    this.setup = new RuntimeSetupRoutes(
      new RuntimeSetupService({
        rootDir: options.rootDir ?? process.cwd(),
        getConfigPath: () =>
          options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
        configure: (configPath) => this.environments.configure(configPath),
        activate: async (_configPath) => {
          const activation = await this.applyWhenRequestsIdle();
          if (activation.status === "ready") {
            await this.initializeSessionReadState([
              options.defaultEnvironmentId,
            ]);
          }
          return activation;
        },
      }),
    );
    this.setupEmbedding = new SetupEmbeddingRoutes(
      new SetupEmbeddingService({
        rootDir: options.rootDir ?? process.cwd(),
        getConfigPath: () =>
          options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
        providerAdapters: options.providerAdapters,
      }),
    );
    this.plugins = new PluginManagementRoutes({
      rootDir: options.rootDir ?? process.cwd(),
      getConfigPath: () =>
        options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
    });
    this.readStates = new WebSessionReadStates((id) =>
      this.environments.get(id),
    );
    this.sessions = new WebSessionRoutes(
      this.readStates,
      notifyWorkspaceChanged,
    );
    this.schedules = new ScheduleManagementRoutes((id) =>
      this.environments.get(id),
    );
    this.memoryOnboarding = new LongTermMemoryOnboardingRoutes(() =>
      createLocalLongTermMemoryOnboardingService({
        rootDir: options.rootDir ?? process.cwd(),
        providerAdapters: options.providerAdapters,
        configPath: options.configPath ?? process.env.LLM_RUNTIME_CONFIG_FILE,
      }),
    );
    this.memoryManagement = new LongTermMemoryManagementRoutes(
      (environmentId) =>
        this.environments.get(environmentId).services.longTermMemory,
    );
  }

  private async applyWhenRequestsIdle() {
    const hasAcknowledgedRequests = this.requests.healthDetails().length > 0;
    if (hasAcknowledgedRequests) {
      return {
        status: "restart_required" as const,
        message:
          "Your agent is working. Wait for active conversations and Jobs to finish, then apply again.",
      };
    }
    return this.environments.applyConfiguration();
  }

  async initializeSessionReadState(
    environmentIds: readonly string[],
  ): Promise<void> {
    for (const id of environmentIds) {
      try {
        if (this.environments.setupRequirement(id)) continue;
        await this.readStates.initialize(id);
      } catch (error) {
        console.error(
          `Web UI read state unavailable for environment ${id}:`,
          error,
        );
      }
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname.slice("/web-api".length) || "/";
    const method = req.method || "GET";
    const segments = pathSegments(pathname);
    const route = segments.join("/");
    if (await this.conversationFiles.handle(route, req, res)) return;

    if (
      await this.modelSetup.handle({
        method,
        route,
        request: req,
        response: res,
      })
    )
      return;
    if (await this.setup.handle({ method, route, request: req, response: res }))
      return;
    if (
      await this.setupEmbedding.handle({
        method,
        route,
        request: req,
        response: res,
      })
    )
      return;
    if (
      method === "PUT" &&
      ["runtime/plugins", "runtime/config/dashboard/file"].includes(route)
    ) {
      if (!acceptConfigMutationRequest(req, res)) return;
    }
    if (method === "POST" && route === "runtime/config/apply") {
      if (!acceptConfigMutationRequest(req, res)) return;
      sendJson(res, 200, {
        ok: true,
        activation: await applyAndCompleteRuntimeSetup(this.setup, () =>
          this.applyWhenRequestsIdle(),
        ),
      });
      return;
    }

    if (route === "chat/attachments") {
      const environmentId = requestEnvironmentId(
        url,
        null,
        this.options.defaultEnvironmentId,
      );
      const setupRequirement =
        this.environments.setupRequirement(environmentId);
      if (setupRequirement) {
        sendRuntimeSetupRequired(res, setupRequirement);
        return;
      }
      const environment = this.environments.get(environmentId);
      if (method === "POST") {
        await this.attachments.upload(req, res, environment);
        return;
      }
      if (method === "GET") {
        await this.attachments.read(req, res, environment);
        return;
      }
      if (method === "DELETE") {
        await this.attachments.delete(req, res, environment);
        return;
      }
    }

    const body =
      method === "GET" || method === "HEAD"
        ? null
        : readJsonBody(await readBody(req));
    const environmentId = requestEnvironmentId(
      url,
      body,
      this.options.defaultEnvironmentId,
    );

    if (method === "POST" && route === "chat/stop") {
      await cancelWebRequest({ request: req, response: res, body, environment: this.environments.get(environmentId) });
      return;
    }

    if (
      await this.learning.handle({
        method,
        route,
        segments,
        url,
        body,
        environmentId,
        request: req,
        response: res,
      })
    )
      return;

    if (
      await this.toolApprovals.handle({
        method,
        segments,
        body,
        environmentId,
        request: req,
        response: res,
      })
    )
      return;

    if (await this.plugins.handle({ method, route, body, response: res }))
      return;

    if (segments[0] === "schedules")
      await this.initializeSessionReadState([environmentId]);

    if (
      await this.schedules.handle({
        method,
        segments,
        url,
        body,
        environmentId,
        response: res,
      })
    ) {
      return;
    }

    if (
      await this.memoryOnboarding.handle({
        method,
        route,
        url,
        body,
        request: req,
        response: res,
      })
    ) {
      return;
    }

    if (
      await this.memoryManagement.handle({
        method,
        route,
        segments,
        url,
        body,
        environmentId,
        request: req,
        response: res,
      })
    ) {
      return;
    }

    if (method === "GET" && route === "runtime/config/dashboard") {
      res.setHeader("cache-control", "no-store");
      const waitsForMutations = url.searchParams.get("settled") === "true";
      const readDashboard = waitsForMutations
        ? getSettledConfigDashboardSnapshot
        : getConfigDashboardSnapshot;
      sendJson(res, 200, {
        ok: true,
        dashboard: await readDashboard({
          rootDir: this.options.rootDir ?? process.cwd(),
          configPath: this.options.configPath,
        }),
      });
      return;
    }

    if (method === "PUT" && route === "runtime/config/dashboard/file") {
      res.setHeader("cache-control", "no-store");
      const kind = readConfigFileKind(body?.kind);
      if (!kind) {
        sendJson(res, 400, { ok: false, error: "invalid_config_file_kind" });
        return;
      }
      const expectedRevision = getString(body?.expectedRevision);
      if (!expectedRevision) {
        sendJson(res, 428, {
          ok: false,
          error: "config_revision_required",
          message: "Reload Configuration before saving this file.",
        });
        return;
      }
      try {
        const result = await saveConfigDashboardFile({
          rootDir: this.options.rootDir ?? process.cwd(),
          configPath: this.options.configPath,
          kind,
          id: getString(body?.id),
          config: body?.config,
          expectedRevision,
        });
        sendJson(res, 200, { ...result, restartRequired: true });
      } catch (error) {
        if (!(error instanceof ConfigFileConflictError)) throw error;
        sendJson(res, 409, {
          ok: false,
          error: error.code,
          message: error.message,
        });
      }
      return;
    }

    if (method === "GET" && route === "chat/models") {
      const pendingSetup = await pendingRuntimeSetupCatalog(this.setup);
      sendJson(res, 200, {
        ok: true,
        ...(pendingSetup ?? this.environments.modelCatalog(environmentId)),
        modes: [],
      });
      return;
    }

    if (
      (method === "GET" && route === "chat/sessions") ||
      (method === "POST" && route === "chat/messages")
    ) {
      const setupRequirement =
        this.environments.setupRequirement(environmentId);
      if (setupRequirement && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          sessions: [],
          availability: setupRequirement,
        });
        return;
      }
      if (setupRequirement) {
        sendRuntimeSetupRequired(res, setupRequirement);
        return;
      }
    }

    const environment = this.environments.get(environmentId);
    if (
      await this.projects.handle({
        method,
        segments,
        url,
        body,
        environment,
        request: req,
        response: res,
      })
    )
      return;

    if (
      await this.sessions.handle({
        method,
        segments,
        body,
        environmentId,
        environment,
        response: res,
      })
    )
      return;

    if (method === "POST" && route === "chat/messages") {
      await this.requests.start(
        res,
        body ?? {},
        environmentId,
        this.environments.get(environmentId),
      );
      return;
    }

    if (
      method === "GET" &&
      segments[0] === "requests" &&
      segments[1] &&
      segments[2] === "events"
    ) {
      const afterSeq = Number(url.searchParams.get("afterSeq") || 0);
      const normalizedAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0;
      const replay = await environment.services.sessions.getRequestReplayById(
        segments[1],
        normalizedAfterSeq,
      );
      if (!replay) {
        const active = this.requests.activeReplay(
          segments[1],
          normalizedAfterSeq,
        );
        if (active) {
          sendJson(res, 200, active);
          return;
        }
        sendJson(res, 404, {
          ok: false,
          error: "request_events_not_found",
          events: [],
          finalState: null,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        requestId: replay.requestId,
        events: replay.events,
        finalState: replay.finalState,
      });
      return;
    }

    if (method === "GET" && route === "runtime/status") {
      sendJson(res, 200, {
        ok: true,
        source: "local-runtime",
        status: getRuntimeStatus({
          rootDir: this.options.rootDir,
          configPath: this.options.configPath,
          env: this.environments.profileEnv(environmentId),
        }),
      });
      return;
    }

    if (method === "GET" && route === "runtime/logs") {
      sendJson(res, 200, {
        ok: true,
        log: await tailRuntimeLog({
          rootDir: this.options.rootDir,
          configPath: this.options.configPath,
          env: this.environments.profileEnv(environmentId),
          lines: url.searchParams.get("lines") ?? undefined,
        }),
      });
      return;
    }

    if (method === "GET" && route === "runtime/config") {
      sendJson(res, 200, {
        ok: true,
        ...getRuntimeConfig({
          rootDir: this.options.rootDir,
          configPath: this.options.configPath,
          env: this.environments.profileEnv(environmentId),
        }),
      });
      return;
    }

    if (method === "GET" && route === "runtime/config/schema") {
      sendJson(res, 200, { ok: true, schema: getRuntimeConfigSchema() });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  }
}
