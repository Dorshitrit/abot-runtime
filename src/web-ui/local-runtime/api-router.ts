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
  saveConfigDashboardFile,
} from "../config-dashboard-backend.js";
import {
  deleteSessionAttachmentsIfSupported,
  LocalAttachmentRoutes,
} from "./attachment-routes.js";
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
  private readonly attachments = new LocalAttachmentRoutes();
  private readonly memoryManagement: LongTermMemoryManagementRoutes;
  private readonly memoryOnboarding: LongTermMemoryOnboardingRoutes;

  constructor(
    private readonly options: ResolvedLocalRuntimeBackendOptions,
    private readonly environments: RuntimeEnvironmentRegistry,
    private readonly requests: LocalRequestExecution,
  ) {
    this.memoryOnboarding = new LongTermMemoryOnboardingRoutes(
      createLocalLongTermMemoryOnboardingService({
        rootDir: options.rootDir ?? process.cwd(),
        providerAdapters: options.providerAdapters,
        ...(options.configPath ? { configPath: options.configPath } : {}),
      }),
    );
    this.memoryManagement = new LongTermMemoryManagementRoutes(
      (environmentId) =>
        this.environments.get(environmentId).services.longTermMemory,
    );
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname.slice("/web-api".length) || "/";
    const method = req.method || "GET";
    const segments = pathSegments(pathname);
    const route = segments.join("/");

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
      sendJson(res, 200, {
        ok: true,
        dashboard: await getConfigDashboardSnapshot({
          rootDir: this.options.rootDir ?? process.cwd(),
          configPath: this.options.configPath,
        }),
      });
      return;
    }

    if (method === "PUT" && route === "runtime/config/dashboard/file") {
      const kind = readConfigFileKind(body?.kind);
      if (!kind) {
        sendJson(res, 400, { ok: false, error: "invalid_config_file_kind" });
        return;
      }
      const result = await saveConfigDashboardFile({
        rootDir: this.options.rootDir ?? process.cwd(),
        configPath: this.options.configPath,
        kind,
        id: getString(body?.id),
        config: body?.config,
      });
      sendJson(res, 200, { ...result, restartRequired: true });
      return;
    }

    if (method === "GET" && route === "chat/models") {
      sendJson(res, 200, {
        ok: true,
        ...this.environments.modelCatalog(environmentId),
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

    if (method === "GET" && route === "chat/sessions") {
      const result = await environment.services.sessions.listSessions();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (
      method === "GET" &&
      segments[0] === "chat" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments[3] === "messages"
    ) {
      const snapshot = await environment.services.sessions.getSessionSnapshot(
        segments[2],
        { includeRequests: true },
      );
      if (!snapshot) {
        sendJson(res, 404, {
          ok: false,
          error: "session_not_found",
          messages: [],
          requests: [],
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sessionId: snapshot.sessionId,
        title: snapshot.title,
        messages: snapshot.messages,
        requests: snapshot.requests,
        nextCursor: snapshot.nextCursor,
        readState: this.readState(snapshot.sessionId),
      });
      return;
    }

    if (
      method === "DELETE" &&
      segments[0] === "chat" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments[3] === "messages"
    ) {
      const result = await environment.services.sessions.clearSessionMessages(
        segments[2],
      );
      if (!result) {
        sendJson(res, 404, { ok: false, error: "session_not_found" });
        return;
      }
      await deleteSessionAttachmentsIfSupported(environment, segments[2]);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (
      method === "DELETE" &&
      segments[0] === "chat" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments.length === 3
    ) {
      const result = await environment.services.sessions.deleteSessionWithStats(
        segments[2],
      );
      if (result.deleted) {
        await deleteSessionAttachmentsIfSupported(environment, segments[2]);
      }
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (
      method === "POST" &&
      segments[0] === "chat" &&
      segments[1] === "sessions" &&
      segments[2] &&
      segments[3] === "read"
    ) {
      sendJson(res, 200, { ok: true, readState: this.readState(segments[2]) });
      return;
    }

    if (method === "POST" && route === "chat/messages") {
      await this.requests.start(res, body ?? {}, environmentId, environment);
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

  private readState(sessionId: string): Record<string, unknown> {
    return {
      sessionId,
      unreadCount: 0,
      hasUnread: false,
      lastReadAt: Date.now(),
    };
  }
}
