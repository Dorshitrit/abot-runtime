import type { ServerResponse } from "node:http";
import type { RuntimeConfig } from "../../runtime/ports.js";
import type {
  SchedulerService,
  UpdateSchedulerJobInput,
} from "../../runtime/scheduler/contracts.js";
import { requireAvailableScheduleModel } from "../../runtime/capabilities/scheduling/model-validation.js";
import type { JsonObject } from "./contracts.js";
import { sendJson } from "./http.js";
import { readScheduleRunPage } from "./schedule-run-page.js";
import {
  createWebScheduleJob,
  type ScheduleConversationStore,
} from "./schedule-job-creation.js";

type ScheduleRouteRequest = {
  method: string;
  segments: readonly string[];
  url: URL;
  body: JsonObject | null;
  environmentId: string;
  response: ServerResponse;
};

type ScheduleEnvironment = {
  start(): Promise<void>;
  services: {
    config: RuntimeConfig;
    scheduler?: Omit<SchedulerService, "start" | "stop">;
    sessions?: ScheduleConversationStore;
  };
};

function isScheduleRunCollection(segments: readonly string[]): boolean {
  if (segments.length !== 2) return false;
  return segments[1] === "runs";
}

function sendScheduleError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof Error && "code" in error ? String(error.code) : message;
  const isMissingRecord = code.includes("not_found");
  const isUnavailable =
    code === "scheduler_store_in_use" || code === "scheduler_stopped";
  if (isMissingRecord) {
    sendJson(response, 404, { ok: false, error: code, message });
    return;
  }
  if (isUnavailable) {
    sendJson(response, 409, { ok: false, error: code, message });
    return;
  }
  sendJson(response, 400, { ok: false, error: code, message });
}

export class ScheduleManagementRoutes {
  constructor(
    private readonly resolveEnvironment: (id: string) => ScheduleEnvironment,
  ) {}

  async handle(request: ScheduleRouteRequest): Promise<boolean> {
    if (request.segments[0] !== "schedules") return false;
    try {
      const environment = this.resolveEnvironment(request.environmentId);
      await environment.start();
      const service = environment.services.scheduler;
      if (!service) throw new Error("scheduler_unavailable");
      await this.handleScheduleRoute(request, environment, service);
    } catch (error) {
      sendScheduleError(request.response, error);
    }
    return true;
  }

  private async handleScheduleRoute(
    request: ScheduleRouteRequest,
    environment: ScheduleEnvironment,
    service: Omit<SchedulerService, "start" | "stop">,
  ): Promise<void> {
    const [, id, action] = request.segments;
    const { response, method, body } = request;
    if (!id) {
      await this.handleCollection(request, environment, service);
      return;
    }
    if (request.segments.length > 3) {
      sendJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    if (isScheduleRunCollection(request.segments)) {
      await this.handleRunCollection(request, service);
      return;
    }
    const job = await service.get(id);
    if (!job) throw new Error("scheduler_job_not_found");
    if (method === "GET" && !action) {
      sendJson(response, 200, { ok: true, job });
      return;
    }
    if (method === "GET" && action === "runs") {
      const page = await readScheduleRunPage(
        service,
        id,
        request.url.searchParams,
      );
      sendJson(response, 200, { ok: true, ...page });
      return;
    }
    if (method === "PATCH" && !action) {
      if (body?.modelProfileId !== undefined)
        requireAvailableScheduleModel(
          environment.services.config,
          body.modelProfileId,
        );
      sendJson(response, 200, {
        ok: true,
        job: await service.update(id, (body ?? {}) as UpdateSchedulerJobInput),
      });
      return;
    }
    if (method === "POST" && action === "run-now") {
      sendJson(response, 200, { ok: true, run: await service.runNow(id) });
      return;
    }
    if (method === "POST" && action === "pause") {
      sendJson(response, 200, { ok: true, job: await service.pause(id) });
      return;
    }
    if (method === "POST" && action === "resume") {
      sendJson(response, 200, { ok: true, job: await service.resume(id) });
      return;
    }
    if (method === "POST" && action === "cancel") {
      sendJson(response, 200, { ok: true, job: await service.cancel(id) });
      return;
    }
    response.setHeader("allow", action ? "GET, POST" : "GET, PATCH");
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }

  private async handleRunCollection(
    request: ScheduleRouteRequest,
    service: Pick<SchedulerService, "listRuns">,
  ): Promise<void> {
    if (request.method !== "GET") {
      request.response.setHeader("allow", "GET");
      sendJson(request.response, 405, {
        ok: false,
        error: "method_not_allowed",
      });
      return;
    }
    const page = await readScheduleRunPage(
      service,
      undefined,
      request.url.searchParams,
    );
    sendJson(request.response, 200, { ok: true, ...page });
  }

  private async handleCollection(
    request: ScheduleRouteRequest,
    environment: ScheduleEnvironment,
    service: Omit<SchedulerService, "start" | "stop">,
  ): Promise<void> {
    if (request.method === "GET") {
      const sessionId = request.url.searchParams.get("sessionId") || undefined;
      const search = request.url.searchParams.get("search") || undefined;
      const state = request.url.searchParams.get("state");
      const jobs = await service.list({ sessionId, search });
      sendJson(request.response, 200, {
        ok: true,
        jobs: state ? jobs.filter((job) => job.state === state) : jobs,
      });
      return;
    }
    if (request.method === "POST") {
      requireAvailableScheduleModel(
        environment.services.config,
        request.body?.modelProfileId,
      );
      const job = await createWebScheduleJob(
        service,
        environment.services.sessions,
        request.body,
      );
      sendJson(request.response, 201, { ok: true, job });
      return;
    }
    request.response.setHeader("allow", "GET, POST");
    sendJson(request.response, 405, { ok: false, error: "method_not_allowed" });
  }
}
